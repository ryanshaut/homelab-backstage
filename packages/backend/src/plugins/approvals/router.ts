import express from 'express';
import { InputError, NotFoundError } from '@backstage/errors';
import {
  ApprovalAuditEntry,
  ApprovalRecord,
  ApprovalsClient,
  ApprovalState,
  normalizeApprovalState,
} from './client';
import { readContinuation } from './continuation';
import { ContinuationLauncher, DecisionResult } from './launcher';
import { verifyCallback } from './signing';
import { ContinuationRow, ContinuationStore } from './store';

/** What happened (or will happen) after the decision. */
export type ContinuationView = {
  templateRef: string;
  requestedBy?: string;
  /** waiting = no decision acted on yet. */
  status: 'waiting' | ContinuationRow['status'];
  taskId?: string;
  error?: string;
};

/** Response of GET /api/approvals/:id, consumed by the approval status page. */
export type ApprovalStatusResponse = {
  id: number;
  state: ApprovalState;
  status: string;
  substatus: string;
  reason?: string;
  approver: string;
  requestedBy?: string;
  title?: string;
  description?: string;
  links: { label: string; url: string }[];
  createdAt: string;
  updatedAt: string;
  continuation?: ContinuationView;
  audit: ApprovalAuditEntry[];
  record: ApprovalRecord;
};

function parsePresentation(data: string): {
  title?: string;
  description?: string;
  links: { label: string; url: string }[];
} {
  try {
    const p = JSON.parse(data)?.presentation ?? {};
    const links = Array.isArray(p.links)
      ? p.links.filter(
          (l: unknown): l is { label: string; url: string } =>
            typeof (l as any)?.label === 'string' &&
            typeof (l as any)?.url === 'string' &&
            /^https?:\/\//.test((l as any).url),
        )
      : [];
    return {
      title: typeof p.title === 'string' ? p.title : undefined,
      description:
        typeof p.description === 'string' ? p.description : undefined,
      links,
    };
  } catch {
    return { links: [] };
  }
}

export function toStatusResponse(
  record: ApprovalRecord,
  audit: ApprovalAuditEntry[],
  continuation?: ContinuationView,
): ApprovalStatusResponse {
  return {
    id: record.id,
    state: normalizeApprovalState(record.status),
    status: record.status,
    substatus: record.substatus,
    reason: record.reason ?? undefined,
    approver: record.approval_subject,
    requestedBy: record.requested_by ?? undefined,
    ...parsePresentation(record.data),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    continuation,
    audit,
    record,
  };
}

const parseId = (raw: string) => {
  if (!/^\d{1,12}$/.test(raw)) {
    throw new InputError(`Invalid approval id '${raw}'`);
  }
  return Number(raw);
};

const CALLBACK_STATUS: Record<DecisionResult['status'], number> = {
  launched: 200,
  'already-handled': 200,
  rejected: 200,
  'no-continuation': 200,
  // Not decided yet / launch failed: non-2xx so a retrying sender tries again.
  pending: 409,
  failed: 502,
};

/**
 * Routes, mounted at /api/approvals:
 *
 *   GET  /:id                      approval + audit + continuation (authenticated)
 *   POST /:id/retry                retry a failed continuation launch (authenticated)
 *   POST /callbacks/:id/:signature decision callback from the approval system
 *                                  (unauthenticated; the HMAC in the URL is the credential)
 */
export function createApprovalsRouter(options: {
  approvals: ApprovalsClient;
  store: ContinuationStore;
  launcher: ContinuationLauncher;
}): express.Router {
  const { approvals, store, launcher } = options;
  const router = express.Router();

  router.post(
    '/callbacks/:id/:signature',
    // Accept any content type; the approval system's payload is advisory.
    express.text({ type: () => true, limit: '64kb' }),
    async (req, res, next) => {
      try {
        const id = parseId(req.params.id);
        if (
          !verifyCallback(
            approvals.config.signingSecret,
            id,
            req.params.signature,
          )
        ) {
          throw new NotFoundError('Unknown callback');
        }
        let body: unknown;
        try {
          body =
            typeof req.body === 'string' && req.body
              ? JSON.parse(req.body)
              : undefined;
        } catch {
          body = undefined;
        }
        const result = await launcher.handleCallback(id, body);
        res.status(CALLBACK_STATUS[result.status]).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get('/:id', async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      const [record, audit, row] = await Promise.all([
        approvals.getApproval(id),
        approvals.getAudit(id),
        store.get(id),
      ]);
      const spec = readContinuation(
        approvals.config.signingSecret,
        record.data,
      );
      const continuation: ContinuationView | undefined = spec && {
        templateRef: spec.templateRef,
        requestedBy: spec.requestedByRef,
        status: row?.status ?? 'waiting',
        taskId: row?.task_id ?? undefined,
        error: row?.error ?? undefined,
      };
      res.json(toStatusResponse(record, audit, continuation));
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/retry', async (req, res, next) => {
    try {
      res.json(await launcher.retry(parseId(req.params.id)));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
