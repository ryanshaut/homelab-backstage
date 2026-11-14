import type { Entity } from '@backstage/catalog-model';
import {
  assertContinuationTemplate,
  buildApprovalData,
  ContinuationSpec,
  readContinuation,
  signContinuation,
  validateApprover,
} from './continuation';
import { ContinuationLauncher, decide, TaskLauncher } from './launcher';
import {
  createGrant,
  readGrant,
  signCallback,
  stableStringify,
  verifyCallback,
} from './signing';
import { ContinuationStore } from './store';
import {
  FakeApprovals,
  SECRET,
  testDatabase,
  testLogger,
} from './__testUtils__';

const spec: ContinuationSpec = {
  templateRef: 'template:default/vm-execute',
  values: { vmName: 'web-1', cpu: 2 },
  requestedByRef: 'user:default/jane',
  requestedByEmail: 'jane@example.com',
  requestTaskId: 'task-1',
};

const dataFor = (
  s: ContinuationSpec,
  signature = signContinuation(SECRET, s),
) =>
  buildApprovalData({ title: 'Approve VM' }, s, signature, {
    templateTitle: 'Request VM',
    taskUrl: 'http://backstage/create/tasks/task-1',
  });

describe('signing', () => {
  it('stableStringify ignores key order and undefined', () => {
    expect(
      stableStringify({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } }),
    ).toBe(stableStringify({ a: { d: [1, { x: 1, y: 2 }] }, b: 1 }));
  });

  it('callback signatures are bound to the approval id', () => {
    const sig = signCallback(SECRET, 42);
    expect(verifyCallback(SECRET, 42, sig)).toBe(true);
    expect(verifyCallback(SECRET, 43, sig)).toBe(false);
    expect(
      verifyCallback('another-secret-0123456789abcdefghijk', 42, sig),
    ).toBe(false);
    expect(verifyCallback(SECRET, 42, 'short')).toBe(false);
  });

  it('grants round-trip and reject tampering, expiry and other purposes', () => {
    const grant = {
      approvalId: 42,
      templateRef: 'template:default/x',
      expiresAt: 2000,
    };
    const token = createGrant(SECRET, grant);
    expect(readGrant(SECRET, token, 1000)).toEqual(grant);
    expect(readGrant(SECRET, token, 3000)).toBeUndefined();

    const [payload, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...grant, approvalId: 43 }),
    ).toString('base64url');
    expect(readGrant(SECRET, `${forged}.${sig}`, 1000)).toBeUndefined();
    expect(
      readGrant(SECRET, `${payload}.${signCallback(SECRET, 42)}`, 1000),
    ).toBeUndefined();
  });
});

describe('continuation', () => {
  it('validates approvers', () => {
    expect(validateApprover(' user::a@b.c ')).toBe('user::a@b.c');
    expect(() => validateApprover('a@b.c')).toThrow(/Invalid approver/);
  });

  it('reads back a signed continuation and rejects tampering', () => {
    expect(readContinuation(SECRET, dataFor(spec))).toEqual(spec);

    const tampered = JSON.parse(dataFor(spec));
    tampered.backstage.continuation.values.cpu = 64;
    expect(readContinuation(SECRET, JSON.stringify(tampered))).toBeUndefined();
    expect(readContinuation(SECRET, 'not json')).toBeUndefined();
  });

  it('puts an ApprovalCard with requester and task link in data', () => {
    const data = JSON.parse(dataFor(spec));
    expect(data.presentation).toMatchObject({
      type: 'ApprovalCard',
      title: 'Approve VM',
      facts: [
        { label: 'Requested by', value: 'jane@example.com' },
        { label: 'Backstage template', value: 'Request VM' },
      ],
      links: [
        {
          label: 'Backstage request',
          url: 'http://backstage/create/tasks/task-1',
        },
      ],
    });
  });

  describe('assertContinuationTemplate', () => {
    const template = (
      labels: Record<string, string>,
      firstAction: string,
    ): Entity => ({
      apiVersion: 'scaffolder.backstage.io/v1beta3',
      kind: 'Template',
      metadata: { name: 'x', labels },
      spec: {
        steps: [{ action: firstAction }, { action: 'webhook:dispatch' }],
      },
    });
    const label = { 'approvals.backstage.io/continuation': 'true' };

    it('accepts labelled templates that start with approval:verify', () => {
      expect(() =>
        assertContinuationTemplate(template(label, 'approval:verify'), 'r'),
      ).not.toThrow();
    });
    it('rejects missing templates, missing label or missing verify step', () => {
      expect(() => assertContinuationTemplate(undefined, 'r')).toThrow(
        /not found/,
      );
      expect(() =>
        assertContinuationTemplate(template({}, 'approval:verify'), 'r'),
      ).toThrow(/label/);
      expect(() =>
        assertContinuationTemplate(template(label, 'webhook:dispatch'), 'r'),
      ).toThrow(/approval:verify/);
    });
  });
});

describe('decide', () => {
  const record = (status: string) => ({ status, reason: null } as any);
  it.each([
    [{ approved: true }, 'approved', 'approved'],
    [{ approved: true }, 'Some-Custom-Status', 'approved'],
    [{ approved: true }, 'pending', 'pending'], // forged / early callback
    [{ approved: true }, 'rejected', 'rejected'], // record wins
    [{ approved: false }, 'pending', 'rejected'],
    [{ approved: false }, 'approved', 'approved'], // record wins
    [undefined, 'approved', 'approved'],
    [undefined, 'pending', 'pending'],
    [{ approved: 'yes' }, 'unknown-word', 'pending'],
  ])('body %j + record %s -> %s', (body, status, outcome) => {
    expect(decide(body, record(status)).outcome).toBe(outcome);
  });
});

describe('ContinuationLauncher', () => {
  let approvals: FakeApprovals;
  let store: ContinuationStore;
  let tasks: { createTask: jest.Mock };
  let notify: jest.Mock;
  let launcher: ContinuationLauncher;
  let approvalId: number;

  beforeEach(async () => {
    approvals = new FakeApprovals();
    store = await ContinuationStore.create(testDatabase());
    tasks = { createTask: jest.fn().mockResolvedValue('task-2') };
    notify = jest.fn().mockResolvedValue(undefined);
    launcher = new ContinuationLauncher({
      approvals: approvals.asClient(),
      store,
      tasks: tasks as TaskLauncher,
      logger: testLogger,
      notify,
      recordRecheckMs: 1,
    });
    ({
      record: { id: approvalId },
    } = await approvals.createApproval({
      idepotency_id: 'k',
      source: 'backstage-test',
      approval_subject: 'user::boss@x',
      data: dataFor(spec),
    }));
  });

  it('launches the continuation once with a grant and the requester', async () => {
    approvals.decide(approvalId, 'approved', 'ok');

    await expect(
      launcher.handleCallback(approvalId, { approved: true }),
    ).resolves.toEqual({
      status: 'launched',
      taskId: 'task-2',
    });
    // A duplicate callback does not start a second task.
    await expect(
      launcher.handleCallback(approvalId, { approved: true }),
    ).resolves.toEqual({
      status: 'already-handled',
      taskId: 'task-2',
    });
    expect(tasks.createTask).toHaveBeenCalledTimes(1);

    const [templateRef, values, secrets] = tasks.createTask.mock.calls[0];
    expect(templateRef).toBe('template:default/vm-execute');
    expect(values).toEqual({ vmName: 'web-1', cpu: 2 });
    expect(secrets.approvalRequestedBy).toBe('user:default/jane');
    expect(readGrant(SECRET, secrets.approvalGrant)).toMatchObject({
      approvalId,
      templateRef: 'template:default/vm-execute',
      requestedByRef: 'user:default/jane',
    });
    expect(notify).toHaveBeenCalledWith(
      'user:default/jane',
      expect.objectContaining({ link: '/create/tasks/task-2' }),
    );
    expect(await store.get(approvalId)).toMatchObject({
      status: 'launched',
      task_id: 'task-2',
    });
  });

  it('does not launch while the record still says pending', async () => {
    await expect(
      launcher.handleCallback(approvalId, { approved: true }),
    ).resolves.toEqual({
      status: 'pending',
    });
    expect(tasks.createTask).not.toHaveBeenCalled();
  });

  it('records and notifies rejections', async () => {
    approvals.decide(approvalId, 'rejected', 'no budget');
    await expect(
      launcher.handleCallback(approvalId, { approved: false }),
    ).resolves.toEqual({
      status: 'rejected',
    });
    expect(tasks.createTask).not.toHaveBeenCalled();
    expect(await store.get(approvalId)).toMatchObject({
      status: 'rejected',
      reason: 'no budget',
    });
    expect(notify).toHaveBeenCalledWith(
      'user:default/jane',
      expect.objectContaining({ severity: 'high' }),
    );
  });

  it('ignores approvals whose continuation was tampered with', async () => {
    const tampered = JSON.parse(dataFor(spec));
    tampered.backstage.continuation.templateRef =
      'template:default/something-else';
    approvals.records.set(approvalId, {
      ...approvals.records.get(approvalId)!,
      status: 'approved',
      data: JSON.stringify(tampered),
    });
    await expect(
      launcher.handleCallback(approvalId, { approved: true }),
    ).resolves.toEqual({
      status: 'no-continuation',
    });
    expect(tasks.createTask).not.toHaveBeenCalled();
  });

  it('marks failed launches and allows a retry', async () => {
    approvals.decide(approvalId, 'approved');
    tasks.createTask.mockRejectedValueOnce(new Error('scaffolder said 400'));

    await expect(
      launcher.handleCallback(approvalId, { approved: true }),
    ).resolves.toMatchObject({
      status: 'failed',
      error: 'scaffolder said 400',
    });
    expect(await store.get(approvalId)).toMatchObject({ status: 'failed' });

    await expect(launcher.retry(approvalId)).resolves.toEqual({
      status: 'launched',
      taskId: 'task-2',
    });
    await expect(launcher.retry(approvalId)).rejects.toThrow(
      /no failed continuation/,
    );
  });
});
