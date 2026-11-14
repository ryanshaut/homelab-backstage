import {
  AuthService,
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import {
  createTemplateAction,
  scaffolderActionsExtensionPoint,
} from '@backstage/plugin-scaffolder-node';
import type { JsonObject } from '@backstage/types';
import {
  ApprovalsClient,
  assertContinuationTemplate,
  buildApprovalData,
  ContinuationSpec,
  GRANT_SECRET,
  normalizeApprovalState,
  normalizeTemplateRef,
  readApprovalsConfig,
  readGrant,
  signCallback,
  signContinuation,
  validateApprover,
} from '../plugins/approvals';

type Deps = {
  approvals: ApprovalsClient;
  catalog: CatalogService;
  auth: AuthService;
  appBaseUrl: string;
};

/**
 * Front half: requests an approval and finishes immediately. When the
 * approval system calls back with an approval, Backstage starts
 * `continuation.templateRef` with `continuation.values` as a new task.
 */
export const createApprovalRequestAction = ({
  approvals,
  catalog,
  auth,
  appBaseUrl,
}: Deps) =>
  createTemplateAction({
    id: 'approval:request',
    description:
      'Requests an approval from the external approval system and completes immediately. ' +
      'Once approved, Backstage starts the continuation template as a new task.',
    schema: {
      input: {
        approver: z =>
          z
            .string()
            .describe(
              'Approval subject, e.g. user::someone@example.com. Set by the template author.',
            ),
        title: z => z.string().describe('Headline shown to the approver'),
        description: z => z.string().optional(),
        facts: z =>
          z
            .array(
              z.object({
                label: z.string(),
                value: z.union([z.string(), z.number(), z.boolean()]),
              }),
            )
            .optional()
            .describe('Label/value pairs on the approval card'),
        notice: z =>
          z.object({ level: z.string(), text: z.string() }).optional(),
        links: z =>
          z
            .array(z.object({ label: z.string(), url: z.string().url() }))
            .optional(),
        context: z => z.record(z.any()).optional(),
        continuation: z =>
          z
            .object({
              templateRef: z
                .string()
                .describe(
                  'Back-half template (labelled approvals.backstage.io/continuation: "true", first step approval:verify)',
                ),
              values: z
                .record(z.any())
                .optional()
                .describe('Parameter values for the back-half template'),
            })
            .describe('What to run once approved'),
      },
      output: {
        approvalId: z => z.number(),
        statusUrl: z => z.string(),
        continuationTemplateRef: z => z.string(),
      },
    },
    async handler(ctx) {
      const { config } = approvals;
      const approver = validateApprover(ctx.input.approver);
      const templateRef = normalizeTemplateRef(
        ctx.input.continuation.templateRef,
      );

      // Fail now, not days later, if the continuation can't run.
      const entity = await catalog.getEntityByRef(templateRef, {
        credentials: await auth.getOwnServiceCredentials(),
      });
      assertContinuationTemplate(entity, templateRef);

      // JSON round-trip drops undefined fields so the signed form matches
      // exactly what is stored in the approval's data.
      const continuation: ContinuationSpec = JSON.parse(
        JSON.stringify({
          templateRef,
          values: (ctx.input.continuation.values ?? {}) as JsonObject,
          requestedByRef: ctx.user?.ref,
          requestedByEmail: ctx.user?.entity?.spec?.profile?.email,
          requestTaskId: ctx.task.id,
          requestTemplateRef: ctx.templateInfo?.entityRef,
        }),
      );
      const taskUrl = `${appBaseUrl}/create/tasks/${ctx.task.id}`;

      const { record, created } = await approvals.createApproval({
        idepotency_id: `backstage:${ctx.task.id}:${ctx.step?.id ?? 'approval'}`,
        source: config.source,
        approval_subject: approver,
        requested_by:
          continuation.requestedByEmail ?? continuation.requestedByRef,
        data: buildApprovalData(
          {
            title: ctx.input.title,
            description: ctx.input.description,
            facts: ctx.input.facts?.map(f => ({
              label: f.label,
              value: String(f.value),
            })),
            notice: ctx.input.notice,
            links: ctx.input.links,
            context: ctx.input.context,
          },
          continuation,
          signContinuation(config.signingSecret, continuation),
          {
            templateTitle:
              ctx.templateInfo?.entity?.metadata.title ??
              ctx.templateInfo?.entity?.metadata.name,
            taskUrl,
          },
        ),
      });

      // The callback URL embeds the approval id, so it is set once the id is known.
      await approvals.updateApproval(record.id, {
        callback_url: `${config.callbackBaseUrl}/api/approvals/callbacks/${
          record.id
        }/${signCallback(config.signingSecret, record.id)}`,
        callback_method: 'POST',
      });

      const statusPath = `/approval-status?id=${record.id}`;
      ctx.logger.info(
        created
          ? `Requested approval #${record.id} from ${approver}`
          : `Approval #${record.id} already existed for this step`,
      );
      ctx.logger.info(
        `Once approved, ${templateRef} starts automatically as a new task. Status: ${appBaseUrl}${statusPath}`,
      );

      ctx.output('approvalId', record.id);
      ctx.output('statusUrl', statusPath);
      ctx.output('continuationTemplateRef', templateRef);
    },
  });

/**
 * Back half guard: must be the first step of every continuation template.
 * Passes only for tasks started by the approvals launcher for an approved
 * request; anything else (e.g. someone running the template directly) fails
 * here, so no later step runs.
 */
export const createApprovalVerifyAction = ({
  approvals,
}: Pick<Deps, 'approvals'>) =>
  createTemplateAction({
    id: 'approval:verify',
    description:
      'Verifies that this task was started by Backstage for an approved request. Use as the first step of continuation templates.',
    schema: {
      input: {},
      output: {
        approvalId: z => z.number(),
        approver: z => z.string(),
        reason: z => z.string().optional(),
        requestedBy: z => z.string().optional(),
        requestedByEmail: z => z.string().optional(),
        requestTaskId: z => z.string().optional(),
      },
    },
    async handler(ctx) {
      const token = ctx.secrets?.[GRANT_SECRET];
      const grant = token
        ? readGrant(approvals.config.signingSecret, token)
        : undefined;
      if (!grant) {
        throw new Error(
          'This template runs only after an approval and cannot be started directly.',
        );
      }
      const currentRef = normalizeTemplateRef(
        ctx.templateInfo?.entityRef ?? '',
      );
      if (grant.templateRef !== currentRef) {
        throw new Error(
          `Approval grant is for ${grant.templateRef}, not ${currentRef}`,
        );
      }

      const record = await approvals.getApproval(grant.approvalId);
      const state = normalizeApprovalState(record.status);
      if (state === 'pending' || state === 'rejected') {
        throw new Error(
          `Approval #${record.id} is '${record.status}', not approved`,
        );
      }

      ctx.logger.info(
        `Approval #${record.id} by ${record.approval_subject} verified (status: ${record.status})`,
      );
      ctx.output('approvalId', record.id);
      ctx.output('approver', record.approval_subject);
      if (record.reason) ctx.output('reason', record.reason);
      if (grant.requestedByRef) ctx.output('requestedBy', grant.requestedByRef);
      if (grant.requestedByEmail) {
        ctx.output('requestedByEmail', grant.requestedByEmail);
      }
      if (grant.requestTaskId) {
        ctx.output('requestTaskId', grant.requestTaskId);
      }
    },
  });

/** Registers approval:request and approval:verify when approvals are configured. */
export const scaffolderApprovalActionsModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'approval-actions',
  register(reg) {
    reg.registerInit({
      deps: {
        scaffolderActions: scaffolderActionsExtensionPoint,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        auth: coreServices.auth,
        catalog: catalogServiceRef,
      },
      async init({ scaffolderActions, config, logger, auth, catalog }) {
        const approvalsConfig = readApprovalsConfig(config);
        if (!approvalsConfig) {
          logger.info(
            'approvals.baseUrl is not set; approval actions are not registered',
          );
          return;
        }
        const approvals = new ApprovalsClient(approvalsConfig);
        scaffolderActions.addActions(
          createApprovalRequestAction({
            approvals,
            catalog,
            auth,
            appBaseUrl: config.getString('app.baseUrl').replace(/\/+$/, ''),
          }),
          createApprovalVerifyAction({ approvals }),
        );
      },
    });
  },
});
