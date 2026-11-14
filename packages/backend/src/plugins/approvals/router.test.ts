import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { MiddlewareFactory } from '@backstage/backend-defaults/rootHttpRouter';
import { ConfigReader } from '@backstage/config';
import express from 'express';
import { buildApprovalData, signContinuation } from './continuation';
import { ContinuationLauncher, TaskLauncher } from './launcher';
import { createApprovalsRouter } from './router';
import { signCallback } from './signing';
import { ContinuationStore } from './store';
import {
  FakeApprovals,
  SECRET,
  testDatabase,
  testLogger,
} from './__testUtils__';

describe('approvals router', () => {
  let server: Server;
  let baseUrl: string;
  let approvals: FakeApprovals;
  let tasks: { createTask: jest.Mock };
  let id: number;

  beforeEach(async () => {
    approvals = new FakeApprovals();
    const store = await ContinuationStore.create(testDatabase());
    tasks = { createTask: jest.fn().mockResolvedValue('task-2') };
    const launcher = new ContinuationLauncher({
      approvals: approvals.asClient(),
      store,
      tasks: tasks as TaskLauncher,
      logger: testLogger,
      recordRecheckMs: 1,
    });
    const router = createApprovalsRouter({
      approvals: approvals.asClient(),
      store,
      launcher,
    });
    router.use(
      MiddlewareFactory.create({
        config: new ConfigReader({}),
        logger: testLogger,
      }).error(),
    );
    server = createServer(express().use('/api/approvals', router));
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${
      (server.address() as AddressInfo).port
    }/api/approvals`;

    const spec = {
      templateRef: 'template:default/vm-execute',
      values: { vmName: 'web-1' },
      requestedByRef: 'user:default/jane',
      requestTaskId: 'task-1',
    };
    ({
      record: { id },
    } = await approvals.createApproval({
      idepotency_id: 'k',
      source: 'backstage-test',
      approval_subject: 'user::boss@x',
      data: buildApprovalData(
        {
          title: 'Approve VM',
          links: [{ label: 'Plan', url: 'https://plan' }],
        },
        spec,
        signContinuation(SECRET, spec),
        {},
      ),
    }));
  });

  afterEach(() => new Promise<void>(r => server.close(() => r())));

  const callback = (
    body: string,
    sig = signCallback(SECRET, id),
    approvalId = id,
  ) =>
    fetch(`${baseUrl}/callbacks/${approvalId}/${sig}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

  it('rejects callbacks with a bad signature without touching anything', async () => {
    approvals.decide(id, 'approved');
    expect((await callback('{"approved":true}', 'nope')).status).toBe(404);
    expect(
      (await callback('{"approved":true}', signCallback(SECRET, id), id + 1))
        .status,
    ).toBe(404);
    expect(tasks.createTask).not.toHaveBeenCalled();
  });

  it('launches on an approved callback and reports it on the status route', async () => {
    approvals.decide(id, 'approved', 'ok');
    const res = await callback('{"approved":true,"reason":"ok"}');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'launched', taskId: 'task-2' });

    const status = await (await fetch(`${baseUrl}/${id}`)).json();
    expect(status).toMatchObject({
      id,
      state: 'approved',
      title: 'Approve VM',
      links: [{ label: 'Plan', url: 'https://plan' }],
      continuation: {
        templateRef: 'template:default/vm-execute',
        requestedBy: 'user:default/jane',
        status: 'launched',
        taskId: 'task-2',
      },
    });
  });

  it('answers 409 to an approved callback while the record is pending', async () => {
    const res = await callback('{"approved":true}');
    expect(res.status).toBe(409);
    expect(tasks.createTask).not.toHaveBeenCalled();
  });

  it('accepts non-JSON callback bodies and falls back to the record', async () => {
    approvals.decide(id, 'approved');
    const res = await fetch(
      `${baseUrl}/callbacks/${id}/${signCallback(SECRET, id)}`,
      { method: 'POST', body: 'approved!' },
    );
    expect(res.status).toBe(200);
    expect(tasks.createTask).toHaveBeenCalledTimes(1);
  });

  it('shows a waiting continuation before any decision', async () => {
    const status = await (await fetch(`${baseUrl}/${id}`)).json();
    expect(status.continuation.status).toBe('waiting');
  });

  it('rejects malformed ids', async () => {
    expect((await fetch(`${baseUrl}/abc`)).status).toBe(400);
  });
});
