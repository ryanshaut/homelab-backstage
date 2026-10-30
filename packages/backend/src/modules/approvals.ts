import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import {
  createTemplateAction,
  scaffolderActionsExtensionPoint,
  scaffolderServiceRef,
} from '@backstage/plugin-scaffolder-node';
import type { JsonValue } from '@backstage/types';
import express from 'express';

const TABLE = 'approval_requests';
const POLL_INTERVAL_MINUTES = 1;
const REQUEST_TIMEOUT_MS = 15_000;

type ApprovalStatus = 'submitting' | 'pending' | 'approved' | 'rejected';

type ApprovalRequest = {
  id: string;
  task_id: string;
  step_id: string;
  template_ref: string;
  user_ref: string;
  approval_subject: string;
  values: string;
  data: string;
  callback_id: string;
  callback_url: string;
  idempotency_id: string;
  status: ApprovalStatus;
  reason: string | null;
  resume_task_id: string | null;
  consumed_at: Date | null;
  created_at: Date;
};

type JsonObject = Record<string, JsonValue>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isRecord(value) && Object.values(value).every(isJsonValue);
};

const parseJsonObject = (value: string, fieldName: string): JsonObject => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Stored approval ${fieldName} is not valid JSON`, {
      cause: error,
    });
  }
  if (!isRecord(parsed) || !isJsonValue(parsed)) {
    throw new Error(`Stored approval ${fieldName} must be a JSON object`);
  }
  return parsed as JsonObject;
};

const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
};

const readJsonResponse = async (
  response: Response,
  operation: string,
): Promise<unknown> => {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${operation} failed (${response.status}): ${text}`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`${operation} returned invalid JSON`, { cause: error });
  }
};

const createCallback = async (webhookBaseUrl: string) => {
  const response = await fetch(`${webhookBaseUrl}/api/callbacks`, {
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const callback = await readJsonResponse(response, 'Callback creation');
  if (
    !isRecord(callback) ||
    typeof callback.id !== 'string' ||
    typeof callback.callback_url !== 'string'
  ) {
    throw new Error('Callback creation returned an invalid response');
  }

  const callbackUrl = new URL(callback.callback_url, webhookBaseUrl);
  if (callbackUrl.origin !== new URL(webhookBaseUrl).origin) {
    throw new Error('Callback URL must use the configured webhook origin');
  }
  return { id: callback.id, url: callbackUrl.toString() };
};

const getAccessToken = async (): Promise<string> => {
  const discoveryUrl = requiredEnv('KC_ODIC_DISCOVERY_URI');
  const discoveryResponse = await fetch(discoveryUrl, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const discovery = await readJsonResponse(
    discoveryResponse,
    'OIDC discovery request',
  );
  if (!isRecord(discovery) || typeof discovery.token_endpoint !== 'string') {
    throw new Error('OIDC discovery document has no token_endpoint');
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: requiredEnv('KC_SA_UN'),
    client_secret: requiredEnv('KC_SA_PW'),
  });
  const tokenResponse = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const token = await readJsonResponse(tokenResponse, 'OIDC token request');
  if (!isRecord(token) || typeof token.access_token !== 'string') {
    throw new Error('OIDC token response has no access_token');
  }
  return token.access_token;
};

const sendApprovalRequest = async (row: ApprovalRequest): Promise<void> => {
  const accessToken = await getAccessToken();
  const response = await fetch(requiredEnv('APPROVALS_URL'), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      idepotency_id: row.idempotency_id,
      source: 'local',
      data: row.data,
      approval_subject: row.approval_subject,
      callback_url: row.callback_url,
      callback_method: 'POST',
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await readJsonResponse(response, 'Approval request');
};

const readCallbackDecision = async (
  webhookBaseUrl: string,
  callbackId: string,
): Promise<{ approved: boolean; reason?: string } | undefined> => {
  const response = await fetch(
    `${webhookBaseUrl}/api/webhooks/${encodeURIComponent(callbackId)}`,
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`Callback poll failed (${response.status})`);
  }

  const result = await readJsonResponse(response, 'Callback poll');
  if (!isRecord(result) || typeof result.approved !== 'boolean') {
    return undefined;
  }
  return {
    approved: result.approved,
    ...(typeof result.reason === 'string' ? { reason: result.reason } : {}),
  };
};

export const approvalsModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'approvals',
  register(reg) {
    reg.registerInit({
      deps: {
        scaffolderActions: scaffolderActionsExtensionPoint,
        scaffolderService: scaffolderServiceRef,
        database: coreServices.database,
        scheduler: coreServices.scheduler,
        auth: coreServices.auth,
        rootConfig: coreServices.rootConfig,
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        logger: coreServices.logger,
      },
      async init({
        scaffolderActions,
        scaffolderService,
        database,
        scheduler,
        auth,
        rootConfig,
        httpRouter,
        httpAuth,
        logger,
      }) {
        const db = await database.getClient();
        if (!(await db.schema.hasTable(TABLE))) {
          await db.schema.createTable(TABLE, table => {
            table.string('id').primary();
            table.string('task_id').notNullable();
            table.string('step_id').notNullable();
            table.string('template_ref').notNullable();
            table.string('user_ref').notNullable();
            table.string('approval_subject').notNullable();
            table.text('values').notNullable();
            table.text('data').notNullable();
            table.string('callback_id').notNullable();
            table.text('callback_url').notNullable();
            table.string('idempotency_id').notNullable();
            table.string('status').notNullable();
            table.text('reason').nullable();
            table.string('resume_task_id').nullable();
            table.timestamp('consumed_at').nullable();
            table.timestamp('created_at').notNullable().defaultTo(db.fn.now());
            table.unique(['task_id', 'step_id']);
            table.index(['status']);
          });
        }

        const webhookBaseUrl = requiredEnv('WEBHOOK_BASE_URL').replace(
          /\/+$/,
          '',
        );
        const backendBaseUrl = rootConfig
          .getString('backend.baseUrl')
          .replace(/\/+$/, '');

        scaffolderActions.addActions(
          createTemplateAction({
            id: 'approval:dispatch',
            description:
              'Submit a human approval request and resume the template after a decision',
            schema: {
              input: {
                approvalSubject: z => z.string().min(1),
                summary: z => z.string().min(1),
                values: z => z.record(z.any()),
                data: z => z.record(z.any()).optional(),
                approvalId: z => z.string().optional(),
              },
              output: {
                approved: z => z.boolean(),
                approvalId: z => z.string(),
                status: z => z.string(),
                statusUrl: z => z.string(),
                reason: z => z.string().optional(),
              },
            },
            async handler(ctx) {
              const templateRef = ctx.templateInfo?.entityRef;
              const stepId = ctx.step?.id;
              if (!templateRef || !stepId) {
                throw new Error(
                  'Approval action requires template and step context',
                );
              }

              if (ctx.input.approvalId) {
                const row = (await db(TABLE)
                  .where({
                    id: ctx.input.approvalId,
                    template_ref: templateRef,
                    step_id: stepId,
                  })
                  .first()) as ApprovalRequest | undefined;
                if (
                  !row ||
                  (row.status !== 'approved' && row.status !== 'rejected') ||
                  row.consumed_at
                ) {
                  throw new Error('Invalid or already-used approval');
                }

                const consumed = await db(TABLE)
                  .where({
                    id: row.id,
                    template_ref: templateRef,
                    step_id: stepId,
                    status: row.status,
                  })
                  .whereNull('consumed_at')
                  .update({ consumed_at: db.fn.now() });
                if (!consumed) {
                  throw new Error('Invalid or already-used approval');
                }

                ctx.output('approved', row.status === 'approved');
                ctx.output('approvalId', row.id);
                ctx.output('status', row.status);
                ctx.output(
                  'statusUrl',
                  `${backendBaseUrl}/api/scaffolder/approvals/${encodeURIComponent(
                    row.id,
                  )}`,
                );
                if (row.reason) {
                  ctx.output('reason', row.reason);
                }
                return;
              }

              const approvalId = await ctx.checkpoint({
                key: `approval-${stepId}`,
                fn: async () => {
                  let row = (await db(TABLE)
                    .where({ task_id: ctx.task.id, step_id: stepId })
                    .first()) as ApprovalRequest | undefined;

                  if (!row) {
                    const callback = await createCallback(webhookBaseUrl);
                    const id = crypto.randomUUID();
                    const values = JSON.stringify(ctx.input.values);
                    const data = JSON.stringify({
                      ...(ctx.input.data ?? ctx.input.values),
                      summary: ctx.input.summary,
                    });
                    await db(TABLE).insert({
                      id,
                      task_id: ctx.task.id,
                      step_id: stepId,
                      template_ref: templateRef,
                      user_ref: ctx.user?.ref ?? 'unknown',
                      approval_subject: ctx.input.approvalSubject,
                      values,
                      data,
                      callback_id: callback.id,
                      callback_url: callback.url,
                      idempotency_id: crypto.randomUUID(),
                      status: 'submitting',
                    });
                    row = (await db(TABLE).where({ id }).first()) as
                      | ApprovalRequest
                      | undefined;
                    if (!row) {
                      throw new Error(
                        `Could not load newly created approval ${id}`,
                      );
                    }
                  }

                  if (row.status === 'submitting') {
                    await sendApprovalRequest(row);
                    await db(TABLE)
                      .where({ id: row.id, status: 'submitting' })
                      .update({ status: 'pending' });
                  } else if (row.status !== 'pending') {
                    throw new Error(
                      `Approval request ${row.id} is already ${row.status}`,
                    );
                  }
                  return row.id;
                },
              });

              ctx.output('approved', false);
              ctx.output('approvalId', approvalId);
              ctx.output('status', 'pending');
              ctx.output(
                'statusUrl',
                `${backendBaseUrl}/api/scaffolder/approvals/${encodeURIComponent(
                  approvalId,
                )}`,
              );
              ctx.logger.info(
                `Approval ${approvalId} submitted; the template will resume after a decision.`,
              );
            },
          }),
        );

        httpRouter.addAuthPolicy({
          path: '/approvals/:id',
          allow: 'user-cookie',
        });
        const router = express.Router();
        router.get('/approvals/:id', async (req, res, next) => {
          try {
            const credentials = await httpAuth.credentials(req, {
              allow: ['user'],
              allowLimitedAccess: true,
            });
            const row = (await db(TABLE)
              .where({ id: req.params.id })
              .first()) as ApprovalRequest | undefined;
            if (!row || row.user_ref !== credentials.principal.userEntityRef) {
              res.status(404).json({ error: 'Approval not found' });
              return;
            }
            res.json({
              id: row.id,
              status: row.status,
              reason: row.reason,
              createdAt: row.created_at,
              resumeTaskId: row.resume_task_id,
            });
          } catch (error) {
            next(error);
          }
        });
        httpRouter.use(router);

        await scheduler.scheduleTask({
          id: 'approval-poller',
          frequency: { minutes: POLL_INTERVAL_MINUTES },
          timeout: { minutes: 5 },
          initialDelay: { seconds: 30 },
          fn: async () => {
            const pending = (await db(TABLE).where({
              status: 'pending',
            })) as ApprovalRequest[];
            for (const row of pending) {
              try {
                const decision = await readCallbackDecision(
                  webhookBaseUrl,
                  row.callback_id,
                );
                if (!decision) {
                  continue;
                }
                const status = decision.approved ? 'approved' : 'rejected';
                await db(TABLE)
                  .where({ id: row.id, status: 'pending' })
                  .update({ status, reason: decision.reason ?? null });
              } catch (error) {
                logger.warn(`Could not poll approval ${row.id}`, {
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }

            const decisions = (await db(TABLE)
              .whereIn('status', ['approved', 'rejected'])
              .whereNull('resume_task_id')
              .whereNull('consumed_at')) as ApprovalRequest[];
            for (const row of decisions) {
              try {
                const values = parseJsonObject(row.values, 'values');
                values.approvalId = row.id;
                const { taskId } = await scaffolderService.scaffold(
                  {
                    templateRef: row.template_ref,
                    values,
                  },
                  { credentials: await auth.getOwnServiceCredentials() },
                );
                await db(TABLE)
                  .where({ id: row.id })
                  .whereNull('resume_task_id')
                  .update({ resume_task_id: taskId });
                logger.info(
                  `Resumed template for approval ${row.id} as task ${taskId}`,
                );
              } catch (error) {
                logger.warn(`Could not resume approval ${row.id}; will retry`, {
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          },
        });
      },
    });
  },
});
