import type { AuthService } from '@backstage/backend-plugin-api';
import type { Entity } from '@backstage/catalog-model';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import {
  createGrant,
  readContinuation,
  verifyCallback,
} from '../plugins/approvals';
import {
  FakeApprovals,
  SECRET,
  testLogger,
} from '../plugins/approvals/__testUtils__';
import {
  createApprovalRequestAction,
  createApprovalVerifyAction,
} from './scaffolderApprovalActions';

const continuationTemplate: Entity = {
  apiVersion: 'scaffolder.backstage.io/v1beta3',
  kind: 'Template',
  metadata: {
    name: 'vm-execute',
    labels: { 'approvals.backstage.io/continuation': 'true' },
  },
  spec: { steps: [{ action: 'approval:verify' }] },
};

function makeCtx(overrides: Record<string, unknown>) {
  const outputs: Record<string, unknown> = {};
  return {
    outputs,
    ctx: {
      logger: testLogger,
      task: { id: 'task-1' },
      step: { id: 'approval' },
      user: {
        ref: 'user:default/jane',
        entity: { spec: { profile: { email: 'jane@example.com' } } },
      },
      templateInfo: {
        entityRef: 'template:default/vm-request',
        entity: { metadata: { name: 'vm-request', title: 'Request VM' } },
      },
      secrets: {},
      output: (name: string, value: unknown) => {
        outputs[name] = value;
      },
      ...overrides,
    },
  };
}

describe('approval:request', () => {
  let approvals: FakeApprovals;
  let catalog: { getEntityByRef: jest.Mock };

  const action = () =>
    createApprovalRequestAction({
      approvals: approvals.asClient(),
      catalog: catalog as unknown as CatalogService,
      auth: {
        getOwnServiceCredentials: async () => ({}),
      } as unknown as AuthService,
      appBaseUrl: 'http://backstage',
    });

  const input = {
    approver: 'user::boss@example.com',
    title: 'Approve VM web-1',
    facts: [{ label: 'CPU', value: 4 }],
    continuation: {
      templateRef: 'vm-execute',
      values: { vmName: 'web-1', cpu: 4 },
    },
  };

  beforeEach(() => {
    approvals = new FakeApprovals();
    catalog = {
      getEntityByRef: jest.fn().mockResolvedValue(continuationTemplate),
    };
  });

  it('creates the approval, points its callback at Backstage and completes', async () => {
    const { ctx, outputs } = makeCtx({ input });
    await action().handler(ctx as any);

    expect(catalog.getEntityByRef).toHaveBeenCalledWith(
      'template:default/vm-execute',
      expect.anything(),
    );
    const [create] = approvals.creates;
    expect(create).toMatchObject({
      idepotency_id: 'backstage:task-1:approval',
      source: 'backstage-test',
      approval_subject: 'user::boss@example.com',
      requested_by: 'jane@example.com',
    });
    expect(readContinuation(SECRET, create.data)).toEqual({
      templateRef: 'template:default/vm-execute',
      values: { vmName: 'web-1', cpu: 4 },
      requestedByRef: 'user:default/jane',
      requestedByEmail: 'jane@example.com',
      requestTaskId: 'task-1',
      requestTemplateRef: 'template:default/vm-request',
    });

    const [{ id, update }] = approvals.updates;
    const match = update.callback_url!.match(
      /^https:\/\/backstage\.example\.com\/api\/approvals\/callbacks\/(\d+)\/([\w-]+)$/,
    );
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(id);
    expect(verifyCallback(SECRET, id, match![2])).toBe(true);
    expect(update.callback_method).toBe('POST');

    expect(outputs).toEqual({
      approvalId: id,
      statusUrl: `/approval-status?id=${id}`,
      continuationTemplateRef: 'template:default/vm-execute',
    });
  });

  it('refuses continuation templates that are not guarded', async () => {
    catalog.getEntityByRef.mockResolvedValue({
      ...continuationTemplate,
      metadata: { name: 'vm-execute' },
    });
    const { ctx } = makeCtx({ input });
    await expect(action().handler(ctx as any)).rejects.toThrow(/label/);
    expect(approvals.creates).toHaveLength(0);
  });
});

describe('approval:verify', () => {
  let approvals: FakeApprovals;
  let approvalId: number;
  const action = () =>
    createApprovalVerifyAction({ approvals: approvals.asClient() });

  const grantFor = (overrides: Record<string, unknown> = {}) =>
    createGrant(SECRET, {
      approvalId,
      templateRef: 'template:default/vm-execute',
      requestedByRef: 'user:default/jane',
      expiresAt: Date.now() + 60_000,
      ...overrides,
    } as any);

  const continuationCtx = (secrets: Record<string, string>) =>
    makeCtx({
      input: {},
      user: undefined,
      secrets,
      templateInfo: { entityRef: 'template:default/vm-execute' },
    });

  beforeEach(async () => {
    approvals = new FakeApprovals();
    ({
      record: { id: approvalId },
    } = await approvals.createApproval({
      idepotency_id: 'k',
      source: 'backstage-test',
      approval_subject: 'user::boss@example.com',
      data: '{}',
    }));
    approvals.decide(approvalId, 'approved', 'fine');
  });

  it('passes for launcher-started tasks of approved requests', async () => {
    const { ctx, outputs } = continuationCtx({ approvalGrant: grantFor() });
    await action().handler(ctx as any);
    expect(outputs).toEqual({
      approvalId,
      approver: 'user::boss@example.com',
      reason: 'fine',
      requestedBy: 'user:default/jane',
    });
  });

  it('fails when the template is run directly (no grant)', async () => {
    const { ctx } = continuationCtx({});
    await expect(action().handler(ctx as any)).rejects.toThrow(
      /cannot be started directly/,
    );
  });

  it('fails for a grant issued for another template or an expired grant', async () => {
    const other = continuationCtx({
      approvalGrant: grantFor({ templateRef: 'template:default/other' }),
    });
    await expect(action().handler(other.ctx as any)).rejects.toThrow(
      /grant is for/,
    );
    const expired = continuationCtx({
      approvalGrant: grantFor({ expiresAt: Date.now() - 1 }),
    });
    await expect(action().handler(expired.ctx as any)).rejects.toThrow(
      /cannot be started directly/,
    );
  });

  it('fails if the approval is not (or no longer) approved', async () => {
    approvals.decide(approvalId, 'rejected');
    const { ctx } = continuationCtx({ approvalGrant: grantFor() });
    await expect(action().handler(ctx as any)).rejects.toThrow(/not approved/);
  });
});
