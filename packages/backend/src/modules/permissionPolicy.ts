import {
  coreServices,
  createBackendModule,
  LoggerService,
  UserInfoService,
} from '@backstage/backend-plugin-api';
import { parseEntityRef, stringifyEntityRef } from '@backstage/catalog-model';
import {
  catalogConditions,
  createCatalogConditionalDecision,
} from '@backstage/plugin-catalog-backend/alpha';
import { catalogEntityReadPermission } from '@backstage/plugin-catalog-common/alpha';
import {
  AuthorizeResult,
  isPermission,
  PolicyDecision,
} from '@backstage/plugin-permission-common';
import {
  PermissionPolicy,
  PolicyQuery,
  PolicyQueryUser,
} from '@backstage/plugin-permission-node';
import { policyExtensionPoint } from '@backstage/plugin-permission-node/alpha';
import {
  actionExecutePermission,
  taskCreatePermission,
} from '@backstage/plugin-scaffolder-common/alpha';
import { CONTINUATION_LABEL } from '../plugins/approvals/continuation';

/** Permissions that run templates / actions, and therefore hit real infra. */
const TEMPLATE_RUN_PERMISSIONS = new Set([
  taskCreatePermission.name,
  actionExecutePermission.name,
]);

/**
 * Allows everything, except:
 * - Approval continuation templates (label approvals.backstage.io/continuation)
 *   are invisible to users, so they can only be started by the approvals
 *   launcher (a service principal) after an approval.
 * - Running templates and scaffolder actions is limited to members of
 *   `permission.templateRunnerGroups` when that list is set. Service
 *   principals (backend plugins, e.g. the approvals launcher, and admin-issued
 *   static tokens) are not restricted.
 */
export class HomelabPermissionPolicy implements PermissionPolicy {
  constructor(
    private readonly runnerGroups: ReadonlySet<string>,
    private readonly userInfo: UserInfoService,
  ) {}

  async handle(
    request: PolicyQuery,
    user?: PolicyQueryUser,
  ): Promise<PolicyDecision> {
    if (user && isPermission(request.permission, catalogEntityReadPermission)) {
      return createCatalogConditionalDecision(request.permission, {
        not: catalogConditions.hasLabel({ label: CONTINUATION_LABEL }),
      });
    }
    if (
      !user ||
      this.runnerGroups.size === 0 ||
      !TEMPLATE_RUN_PERMISSIONS.has(request.permission.name)
    ) {
      return { result: AuthorizeResult.ALLOW };
    }
    const { ownershipEntityRefs } = await this.userInfo.getUserInfo(
      user.credentials,
    );
    const allowed = ownershipEntityRefs.some(ref =>
      this.runnerGroups.has(ref.toLocaleLowerCase('en-US')),
    );
    return { result: allowed ? AuthorizeResult.ALLOW : AuthorizeResult.DENY };
  }
}

export function normalizeGroupRefs(refs: string[]): Set<string> {
  return new Set(
    refs.map(ref =>
      stringifyEntityRef(
        parseEntityRef(ref, {
          defaultKind: 'group',
          defaultNamespace: 'default',
        }),
      ).toLocaleLowerCase('en-US'),
    ),
  );
}

function logPolicy(logger: LoggerService, groups: Set<string>) {
  if (groups.size === 0) {
    logger.warn(
      'permission.templateRunnerGroups is not set: every signed-in user can run templates',
    );
  } else {
    logger.info(`Template runs limited to: ${[...groups].join(', ')}`);
  }
}

export const permissionPolicyModule = createBackendModule({
  pluginId: 'permission',
  moduleId: 'homelab-policy',
  register(reg) {
    reg.registerInit({
      deps: {
        policy: policyExtensionPoint,
        config: coreServices.rootConfig,
        userInfo: coreServices.userInfo,
        logger: coreServices.logger,
      },
      async init({ policy, config, userInfo, logger }) {
        const groups = normalizeGroupRefs(
          config.getOptionalStringArray('permission.templateRunnerGroups') ??
            [],
        );
        logPolicy(logger, groups);
        policy.setPolicy(new HomelabPermissionPolicy(groups, userInfo));
      },
    });
  },
});
