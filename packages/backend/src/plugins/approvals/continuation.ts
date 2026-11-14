/*
 * Approval continuations: an approval request carries a signed description of
 * the template to run once it is approved ("the back half").
 *
 *   front-half template ─ approval:request ──► approval system
 *                                                   │ human decides (any time later)
 *   back-half template  ◄── launcher ◄── POST /api/approvals/callbacks/<id>/<sig>
 *     approval:verify (first step) ─► webhook:* steps ...
 *
 * The spec lives in the approval's own `data` (data.backstage.continuation),
 * so the approval system is the durable store and nothing is lost if
 * Backstage restarts while a human is deciding.
 */
import type { Entity } from '@backstage/catalog-model';
import { parseEntityRef, stringifyEntityRef } from '@backstage/catalog-model';
import { InputError } from '@backstage/errors';
import type { JsonObject } from '@backstage/types';
import { sign, stableStringify, verify } from './signing';

/** Label that marks back-half templates; the permission policy hides them from users. */
export const CONTINUATION_LABEL = 'approvals.backstage.io/continuation';
/** Action every back-half template must run first. */
export const VERIFY_ACTION_ID = 'approval:verify';
/** Task secret carrying the launcher's grant. */
export const GRANT_SECRET = 'approvalGrant';
/** Task secret carrying the original requester (tasks launched by Backstage have no user). */
export const REQUESTED_BY_SECRET = 'approvalRequestedBy';

/** Approval subjects look like `user::someone@example.com` or `group::ops`. */
const APPROVER_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*::\S+$/;

export type ContinuationSpec = {
  /** Normalized entity ref of the back-half template. */
  templateRef: string;
  /** Parameter values for the back-half template. */
  values: JsonObject;
  requestedByRef?: string;
  requestedByEmail?: string;
  requestTaskId: string;
  requestTemplateRef?: string;
};

export type ApprovalFact = { label: string; value: string };
export type ApprovalLink = { label: string; url: string };

export type ApprovalCardInput = {
  title: string;
  description?: string;
  facts?: ApprovalFact[];
  notice?: { level: string; text: string };
  links?: ApprovalLink[];
  /** Extra structured context, stored under data.context. */
  context?: JsonObject;
};

export function validateApprover(approver: string): string {
  const trimmed = approver.trim();
  if (!APPROVER_PATTERN.test(trimmed)) {
    throw new InputError(
      `Invalid approver '${approver}': expected an approval subject like user::someone@example.com`,
    );
  }
  return trimmed;
}

export function normalizeTemplateRef(ref: string): string {
  return stringifyEntityRef(
    parseEntityRef(ref, {
      defaultKind: 'template',
      defaultNamespace: 'default',
    }),
  ).toLocaleLowerCase('en-US');
}

/**
 * A template may only be used as a continuation if it is labelled as one
 * (so users cannot see or run it directly) and starts with approval:verify
 * (so it refuses to run without a launcher grant even if it were run).
 */
export function assertContinuationTemplate(
  entity: Entity | undefined,
  ref: string,
) {
  if (!entity || entity.kind.toLocaleLowerCase('en-US') !== 'template') {
    throw new InputError(`Continuation template ${ref} was not found`);
  }
  if (entity.metadata.labels?.[CONTINUATION_LABEL] !== 'true') {
    throw new InputError(
      `Continuation template ${ref} must have the label ${CONTINUATION_LABEL}: "true"`,
    );
  }
  const steps = (entity.spec?.steps ?? []) as { action?: string }[];
  if (steps[0]?.action !== VERIFY_ACTION_ID) {
    throw new InputError(
      `Continuation template ${ref} must start with a ${VERIFY_ACTION_ID} step`,
    );
  }
}

export function signContinuation(
  secret: string,
  spec: ContinuationSpec,
): string {
  return sign(secret, 'continuation', stableStringify(spec));
}

export function buildApprovalData(
  card: ApprovalCardInput,
  continuation: ContinuationSpec,
  signature: string,
  meta: { templateTitle?: string; taskUrl?: string },
): string {
  const facts: ApprovalFact[] = [
    {
      label: 'Requested by',
      value:
        continuation.requestedByEmail ??
        continuation.requestedByRef ??
        'unknown',
    },
    ...(meta.templateTitle
      ? [{ label: 'Backstage template', value: meta.templateTitle }]
      : []),
    ...(card.facts ?? []),
  ];
  const links: ApprovalLink[] = [
    ...(card.links ?? []),
    ...(meta.taskUrl
      ? [{ label: 'Backstage request', url: meta.taskUrl }]
      : []),
  ];

  return JSON.stringify({
    for: card.title,
    details: card.description ?? '',
    presentation: {
      type: 'ApprovalCard',
      version: 1,
      title: card.title,
      description: card.description ?? '',
      facts,
      ...(card.notice && { notice: card.notice }),
      links,
    },
    backstage: {
      taskUrl: meta.taskUrl,
      template: meta.templateTitle,
      continuation,
      continuationSignature: signature,
    },
    ...(card.context && { context: card.context }),
  });
}

/**
 * Extracts the continuation from an approval's `data` and checks its
 * signature. Returns undefined for approvals without a valid continuation.
 */
export function readContinuation(
  secret: string,
  data: string,
): ContinuationSpec | undefined {
  try {
    const parsed = JSON.parse(data);
    const spec = parsed?.backstage?.continuation as
      | ContinuationSpec
      | undefined;
    const signature = parsed?.backstage?.continuationSignature;
    if (
      !spec ||
      typeof signature !== 'string' ||
      !verify(secret, 'continuation', stableStringify(spec), signature)
    ) {
      return undefined;
    }
    return spec;
  } catch {
    return undefined;
  }
}
