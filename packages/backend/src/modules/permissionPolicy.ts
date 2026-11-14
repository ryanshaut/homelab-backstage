import {
  coreServices,
  createBackendModule,
  LoggerService,
  UserInfoService,
} from '@backstage/backend-plugin-api';
import { parseEntityRef, stringifyEntityRef } from '@backstage/catalog-model';
import {
  AuthorizeResult,
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

/** Permissions that run templates / actions, and therefore hit real infra. */
const TEMPLATE_RUN_PERMISSIONS = new Set([
  taskCreatePermission.name,
  actionExecutePermission.name,
]);

/**
 * Allows everything, except that running templates and scaffolder actions is
 * limited to members of `permission.templateRunnerGroups` when that list is
 * set. With the list unset, behaves like the allow-all policy.
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
    if (
      this.runnerGroups.size === 0 ||
      !TEMPLATE_RUN_PERMISSIONS.has(request.permission.name)
    ) {
      return { result: AuthorizeResult.ALLOW };
    }
    if (!user) {
      return { result: AuthorizeResult.DENY };
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
