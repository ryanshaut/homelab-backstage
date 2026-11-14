/*
 * HMAC helpers for the approval continuation flow. All signatures use
 * `approvals.signingSecret` with a distinct purpose prefix, so a value signed
 * for one purpose can never be replayed as another.
 *
 *  - callback: authenticates the unauthenticated callback URL handed to the
 *    approval system (/api/approvals/callbacks/<approvalId>/<sig>).
 *  - continuation: protects the continuation spec stored in the approval's
 *    `data` from being altered inside the approval system.
 *  - grant: short-lived token the launcher passes (as a task secret) to the
 *    continuation task, checked by `approval:verify`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

type Purpose = 'callback' | 'continuation' | 'grant';

/** JSON.stringify with sorted object keys, so signatures are order-independent. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    // Object keys are unique, so a two-way comparison is a total order.
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(',')}}`;
}

export function sign(
  secret: string,
  purpose: Purpose,
  payload: string,
): string {
  return createHmac('sha256', secret)
    .update(`${purpose}\n${payload}`)
    .digest('base64url');
}

export function verify(
  secret: string,
  purpose: Purpose,
  payload: string,
  signature: string,
): boolean {
  const expected = Buffer.from(sign(secret, purpose, payload));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const signCallback = (secret: string, approvalId: number) =>
  sign(secret, 'callback', String(approvalId));

export const verifyCallback = (
  secret: string,
  approvalId: number,
  signature: string,
) => verify(secret, 'callback', String(approvalId), signature);

// ── Grants ──────────────────────────────────────────────────────────────────

export type ApprovalGrant = {
  approvalId: number;
  /** Template the grant is valid for (normalized entity ref). */
  templateRef: string;
  requestedByRef?: string;
  requestedByEmail?: string;
  requestTaskId?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
};

export function createGrant(secret: string, grant: ApprovalGrant): string {
  const payload = Buffer.from(stableStringify(grant)).toString('base64url');
  return `${payload}.${sign(secret, 'grant', payload)}`;
}

/** Returns the grant if the signature is valid and it has not expired. */
export function readGrant(
  secret: string,
  token: string,
  now = Date.now(),
): ApprovalGrant | undefined {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) {
    return undefined;
  }
  if (!verify(secret, 'grant', payload, signature)) {
    return undefined;
  }
  try {
    const grant = JSON.parse(
      Buffer.from(payload, 'base64url').toString(),
    ) as ApprovalGrant;
    return typeof grant.approvalId === 'number' && grant.expiresAt > now
      ? grant
      : undefined;
  } catch {
    return undefined;
  }
}
