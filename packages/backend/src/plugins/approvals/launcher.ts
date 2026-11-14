import { setTimeout as sleep } from 'node:timers/promises';
import type {
  AuthService,
  DiscoveryService,
  LoggerService,
} from '@backstage/backend-plugin-api';
import { ConflictError } from '@backstage/errors';
import type { JsonObject } from '@backstage/types';
import {
  ApprovalRecord,
  ApprovalsClient,
  normalizeApprovalState,
} from './client';
import {
  ContinuationSpec,
  GRANT_SECRET,
  readContinuation,
  REQUESTED_BY_SECRET,
} from './continuation';
import { createGrant } from './signing';
import { ContinuationStore } from './store';

/** Grants only need to outlive task start-up; the verify step runs first. */
const GRANT_TTL_MS = 60 * 60_000;

export interface TaskLauncher {
  /** Creates a scaffolder task and returns its id. */
  createTask(
    templateRef: string,
    values: JsonObject,
    secrets: Record<string, string>,
  ): Promise<string>;
}

/** Starts scaffolder tasks over REST as the approvals plugin's own service identity. */
export class ScaffolderTaskLauncher implements TaskLauncher {
  constructor(
    private readonly auth: AuthService,
    private readonly discovery: DiscoveryService,
  ) {}

  async createTask(
    templateRef: string,
    values: JsonObject,
    secrets: Record<string, string>,
  ): Promise<string> {
    const { token } = await this.auth.getPluginRequestToken({
      onBehalfOf: await this.auth.getOwnServiceCredentials(),
      targetPluginId: 'scaffolder',
    });
    const baseUrl = await this.discovery.getBaseUrl('scaffolder');
    const res = await fetch(`${baseUrl}/v2/tasks`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ templateRef, values, secrets }),
    });
    const text = await res.text();
    if (res.status !== 201) {
      throw new Error(
        `Scaffolder rejected the continuation (${res.status}): ${text.slice(
          0,
          1000,
        )}`,
      );
    }
    return (JSON.parse(text) as { id: string }).id;
  }
}

export type Notify = (
  recipientRef: string,
  payload: {
    title: string;
    description: string;
    link: string;
    severity: 'normal' | 'high';
  },
) => Promise<void>;

export type LauncherDeps = {
  approvals: ApprovalsClient;
  store: ContinuationStore;
  tasks: TaskLauncher;
  logger: LoggerService;
  notify?: Notify;
  /** Re-check delay when a callback says approved but the record lags. */
  recordRecheckMs?: number;
};

export type DecisionResult =
  | { status: 'launched'; taskId: string }
  | { status: 'already-handled'; taskId?: string }
  | { status: 'rejected' }
  | { status: 'pending' }
  | { status: 'failed'; error: string }
  | { status: 'no-continuation' };

type Decision = {
  outcome: 'approved' | 'rejected' | 'pending';
  reason?: string;
};

/**
 * Combines the callback body with the approval record. The record wins when it
 * is decisive; the callback's `approved` flag is only trusted on its own when
 * the record's status word is unrecognized, and never when the record still
 * says pending (so a forged "approved" callback cannot start anything).
 */
export function decide(body: unknown, record: ApprovalRecord): Decision {
  const b = (body ?? {}) as { approved?: unknown; reason?: unknown };
  const bodyApproved = typeof b.approved === 'boolean' ? b.approved : undefined;
  const reason =
    (typeof b.reason === 'string' && b.reason) || record.reason || undefined;
  const state = normalizeApprovalState(record.status);

  if (
    state === 'rejected' ||
    (bodyApproved === false && state !== 'approved')
  ) {
    return { outcome: 'rejected', reason };
  }
  if (state === 'approved' || (bodyApproved === true && state === 'unknown')) {
    return { outcome: 'approved', reason };
  }
  return { outcome: 'pending', reason };
}

export class ContinuationLauncher {
  constructor(private readonly deps: LauncherDeps) {}

  /** Handles a (signature-verified) callback for an approval. */
  async handleCallback(
    approvalId: number,
    body: unknown,
  ): Promise<DecisionResult> {
    const { approvals, logger } = this.deps;
    let record = await approvals.getApproval(approvalId);
    const continuation = readContinuation(
      approvals.config.signingSecret,
      record.data,
    );
    if (!continuation) {
      logger.warn(
        `Approval #${approvalId} called back without a valid continuation; ignoring`,
      );
      return { status: 'no-continuation' };
    }

    let decision = decide(body, record);
    // The approval system may call back before its record update is visible.
    for (let i = 0; i < 3 && decision.outcome === 'pending'; i++) {
      await sleep(this.deps.recordRecheckMs ?? 1000);
      record = await approvals.getApproval(approvalId);
      decision = decide(body, record);
    }

    if (decision.outcome === 'pending') {
      logger.warn(
        `Approval #${approvalId} called back but its record is still '${record.status}'; not launching`,
      );
      return { status: 'pending' };
    }
    if (decision.outcome === 'rejected') {
      await this.deps.store.markRejected(
        approvalId,
        continuation.templateRef,
        decision.reason,
      );
      logger.info(`Approval #${approvalId} rejected; continuation not started`);
      await this.notify(continuation, {
        title: `Request rejected (approval #${approvalId})`,
        description: decision.reason
          ? `Rejected: ${decision.reason}`
          : 'Your request was rejected.',
        link: this.statusLink(approvalId),
        severity: 'high',
      });
      return { status: 'rejected' };
    }
    return this.launch(approvalId, continuation, decision.reason);
  }

  /** Retries a continuation whose launch previously failed. */
  async retry(approvalId: number): Promise<DecisionResult> {
    const row = await this.deps.store.get(approvalId);
    if (row?.status !== 'failed') {
      throw new ConflictError(
        `Approval #${approvalId} has no failed continuation to retry`,
      );
    }
    const record = await this.deps.approvals.getApproval(approvalId);
    const continuation = readContinuation(
      this.deps.approvals.config.signingSecret,
      record.data,
    );
    if (!continuation) {
      throw new ConflictError(
        `Approval #${approvalId} has no valid continuation`,
      );
    }
    return this.launch(approvalId, continuation, row.reason ?? undefined);
  }

  private async launch(
    approvalId: number,
    continuation: ContinuationSpec,
    reason: string | undefined,
  ): Promise<DecisionResult> {
    const { store, tasks, approvals, logger } = this.deps;
    if (
      !(await store.claimLaunch(approvalId, continuation.templateRef, reason))
    ) {
      const row = await store.get(approvalId);
      return { status: 'already-handled', taskId: row?.task_id ?? undefined };
    }

    try {
      const grant = createGrant(approvals.config.signingSecret, {
        approvalId,
        templateRef: continuation.templateRef,
        requestedByRef: continuation.requestedByRef,
        requestedByEmail: continuation.requestedByEmail,
        requestTaskId: continuation.requestTaskId,
        expiresAt: Date.now() + GRANT_TTL_MS,
      });
      const taskId = await tasks.createTask(
        continuation.templateRef,
        continuation.values,
        {
          [GRANT_SECRET]: grant,
          ...(continuation.requestedByRef && {
            [REQUESTED_BY_SECRET]: continuation.requestedByRef,
          }),
        },
      );
      await store.markLaunched(approvalId, taskId);
      logger.info(
        `Approval #${approvalId} approved; started ${continuation.templateRef} as task ${taskId}`,
      );
      await this.notify(continuation, {
        title: `Request approved (approval #${approvalId})`,
        description: `Approved${
          reason ? `: ${reason}` : ''
        }. The rest of your request is now running.`,
        link: `/create/tasks/${taskId}`,
        severity: 'normal',
      });
      return { status: 'launched', taskId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.markFailed(approvalId, message);
      logger.error(
        `Approval #${approvalId} approved but its continuation failed to start: ${message}`,
      );
      await this.notify(continuation, {
        title: `Approved request failed to start (approval #${approvalId})`,
        description: message.slice(0, 300),
        link: this.statusLink(approvalId),
        severity: 'high',
      });
      return { status: 'failed', error: message };
    }
  }

  private statusLink(approvalId: number) {
    return `/approval-status?id=${approvalId}`;
  }

  private async notify(
    continuation: ContinuationSpec,
    payload: Parameters<Notify>[1],
  ) {
    if (!this.deps.notify || !continuation.requestedByRef) {
      return;
    }
    try {
      await this.deps.notify(continuation.requestedByRef, payload);
    } catch (error) {
      this.deps.logger.warn(
        `Could not notify ${continuation.requestedByRef}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
