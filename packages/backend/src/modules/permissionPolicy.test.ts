import type { UserInfoService } from '@backstage/backend-plugin-api';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import type { PolicyQueryUser } from '@backstage/plugin-permission-node';
import {
  actionExecutePermission,
  taskCancelPermission,
  taskCreatePermission,
} from '@backstage/plugin-scaffolder-common/alpha';
import { catalogEntityReadPermission } from '@backstage/plugin-catalog-common/alpha';
import {
  HomelabPermissionPolicy,
  normalizeGroupRefs,
} from './permissionPolicy';

const userInfo = (refs: string[]) =>
  ({
    getUserInfo: async () => ({
      userEntityRef: 'user:default/jane',
      ownershipEntityRefs: refs,
    }),
  } as unknown as UserInfoService);

const user = { credentials: {} } as unknown as PolicyQueryUser;

describe('normalizeGroupRefs', () => {
  it('defaults kind/namespace and lowercases', () => {
    expect([
      ...normalizeGroupRefs(['Platform-Team', 'group:infra/ops']),
    ]).toEqual(['group:default/platform-team', 'group:infra/ops']);
  });
});

describe('HomelabPermissionPolicy', () => {
  it('allows everything when no runner groups are configured', async () => {
    const policy = new HomelabPermissionPolicy(new Set(), userInfo([]));
    await expect(
      policy.handle({ permission: taskCreatePermission }, user),
    ).resolves.toEqual({ result: AuthorizeResult.ALLOW });
  });

  it('limits template runs to runner group members', async () => {
    const groups = normalizeGroupRefs(['platform-team']);
    const member = new HomelabPermissionPolicy(
      groups,
      userInfo(['user:default/jane', 'group:default/Platform-Team']),
    );
    const outsider = new HomelabPermissionPolicy(
      groups,
      userInfo(['user:default/jane', 'group:default/other']),
    );

    for (const permission of [taskCreatePermission, actionExecutePermission]) {
      await expect(member.handle({ permission }, user)).resolves.toEqual({
        result: AuthorizeResult.ALLOW,
      });
      await expect(outsider.handle({ permission }, user)).resolves.toEqual({
        result: AuthorizeResult.DENY,
      });
    }
    // Service principals (no user), e.g. the approvals launcher, may run templates.
    await expect(
      outsider.handle({ permission: taskCreatePermission }),
    ).resolves.toEqual({
      result: AuthorizeResult.ALLOW,
    });
  });

  it('hides approval continuation templates from users only', async () => {
    const policy = new HomelabPermissionPolicy(new Set(), userInfo([]));
    await expect(
      policy.handle({ permission: catalogEntityReadPermission }, user),
    ).resolves.toEqual({
      result: AuthorizeResult.CONDITIONAL,
      pluginId: 'catalog',
      resourceType: 'catalog-entity',
      conditions: {
        not: {
          rule: 'HAS_LABEL',
          resourceType: 'catalog-entity',
          params: { label: 'approvals.backstage.io/continuation' },
        },
      },
    });
    await expect(
      policy.handle({ permission: catalogEntityReadPermission }),
    ).resolves.toEqual({ result: AuthorizeResult.ALLOW });
  });

  it('does not restrict other permissions', async () => {
    const policy = new HomelabPermissionPolicy(
      normalizeGroupRefs(['platform-team']),
      userInfo([]),
    );
    await expect(
      policy.handle({ permission: taskCancelPermission }, user),
    ).resolves.toEqual({ result: AuthorizeResult.ALLOW });
  });
});
