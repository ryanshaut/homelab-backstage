/*
 * Client for the external "Approve Me" approval API.
 *
 * Approvals are asynchronous: Backstage creates the approval with a callback
 * URL pointing back at Backstage (/api/approvals/callbacks/...), and the
 * approval system calls it once a human decides. See continuation.ts.
 */
import type { Config } from '@backstage/config';
import { NotFoundError } from '@backstage/errors';
import { readResponseBody } from '../webhooks/client';

const DEFAULT_SOURCE = 'backstage';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/** Refresh access tokens this long before they expire. */
const TOKEN_EXPIRY_SKEW_MS = 30_000;

export type ApprovalsConfig = {
  /** Approval API base URL, e.g. https://approveme-api.apps.shaut.us */
  baseUrl: string;
  /** `source` sent with every request; the status route only serves these. */
  source: string;
  /**
   * Backstage backend origin as reachable by the approval system; callbacks
   * go to <callbackBaseUrl>/api/approvals/callbacks/<id>/<sig>.
   */
  callbackBaseUrl: string;
  /** HMAC secret for callback URLs, continuation specs and grants. */
  signingSecret: string;
  requestTimeoutMs: number;
  auth: {
    /** OIDC discovery document URL; its token_endpoint is used. */
    metadataUrl: string;
    clientId: string;
    clientSecret: string;
  };
};

function optionalString(config: Config, key: string): string | undefined {
  const value = config.getOptional(key);
  return value === undefined || value === ''
    ? undefined
    : config.getString(key);
}

/**
 * Returns undefined when approvals are not configured (no approvals.baseUrl),
 * so the backend still starts without an approval system.
 */
export function readApprovalsConfig(
  config: Config,
): ApprovalsConfig | undefined {
  const baseUrl = optionalString(config, 'approvals.baseUrl');
  if (!baseUrl) {
    return undefined;
  }
  const requiredSecret = () => {
    const secret = optionalString(config, 'approvals.signingSecret');
    if (!secret || secret.length < 32) {
      throw new Error(
        'approvals.signingSecret must be set (at least 32 characters) when approvals.baseUrl is set',
      );
    }
    return secret;
  };
  const required = (key: string) => {
    const value = optionalString(config, key);
    if (!value) {
      throw new Error(`${key} must be set when approvals.baseUrl is set`);
    }
    return value;
  };

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    source: optionalString(config, 'approvals.source') ?? DEFAULT_SOURCE,
    callbackBaseUrl: (
      optionalString(config, 'approvals.callbackBaseUrl') ??
      config.getString('backend.baseUrl')
    ).replace(/\/+$/, ''),
    signingSecret: requiredSecret(),
    requestTimeoutMs:
      config.getOptionalNumber('approvals.requestTimeoutMs') ??
      DEFAULT_REQUEST_TIMEOUT_MS,
    auth: {
      metadataUrl: required('approvals.auth.metadataUrl'),
      clientId: required('approvals.auth.clientId'),
      clientSecret: required('approvals.auth.clientSecret'),
    },
  };
}

// ── Access tokens (OAuth2 client credentials) ───────────────────────────────

export class ClientCredentialsTokenProvider {
  private tokenEndpoint?: string;
  private cached?: { token: string; expiresAt: number };
  private inflight?: Promise<string>;

  constructor(
    private readonly auth: ApprovalsConfig['auth'],
    private readonly requestTimeoutMs: number,
  ) {}

  async getToken(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt) {
      return this.cached.token;
    }
    // Collapse concurrent refreshes into one token request.
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  invalidate() {
    this.cached = undefined;
  }

  private async fetchToken(): Promise<string> {
    if (!this.tokenEndpoint) {
      const res = await fetch(this.auth.metadataUrl, {
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (!res.ok) {
        throw new Error(
          `OIDC discovery failed (${res.status}) at ${this.auth.metadataUrl}`,
        );
      }
      const discovery = (await res.json()) as { token_endpoint?: string };
      if (!discovery.token_endpoint) {
        throw new Error('OIDC discovery document has no token_endpoint');
      }
      this.tokenEndpoint = discovery.token_endpoint;
    }

    const res = await fetch(this.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.auth.clientId,
        client_secret: this.auth.clientSecret,
      }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!res.ok) {
      // Deliberately omit the body: token errors can echo client details.
      throw new Error(`Token request failed (${res.status})`);
    }
    const body = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!body.access_token) {
      throw new Error('Token response has no access_token');
    }
    const ttlMs = (body.expires_in ?? 60) * 1000;
    this.cached = {
      token: body.access_token,
      expiresAt: Date.now() + Math.max(ttlMs - TOKEN_EXPIRY_SKEW_MS, 0),
    };
    return body.access_token;
  }
}

// ── Approval API ────────────────────────────────────────────────────────────

/** POST /approvals body. Note the API's own spelling of `idepotency_id`. */
export type ApprovalRequestCreate = {
  idepotency_id: string;
  source: string;
  /** JSON-encoded string (presentation card + context). */
  data: string;
  approval_subject: string;
  requested_by?: string;
  callback_url?: string;
  callback_method?: 'POST';
};

export type ApprovalRecord = {
  id: number;
  idepotency_id: string;
  source: string;
  status: string;
  substatus: string;
  approval_subject: string;
  requested_by?: string | null;
  reason?: string | null;
  data: string;
  callback_method?: string | null;
  callback_url?: string | null;
  created_at: string;
  updated_at: string;
};

export type ApprovalAuditEntry = {
  id: number;
  action: string;
  entity: string;
  entity_id: number;
  performed_by: string;
  reason?: string | null;
  created_at: string;
};

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'unknown';

/** Maps the API's free-form status string onto the states Backstage acts on. */
export function normalizeApprovalState(
  status: string | undefined,
): ApprovalState {
  switch ((status ?? '').trim().toLowerCase()) {
    case 'approved':
    case 'approve':
      return 'approved';
    case 'rejected':
    case 'reject':
    case 'denied':
    case 'declined':
      return 'rejected';
    case 'pending':
    case 'open':
    case 'new':
    case 'requested':
    case 'created':
      return 'pending';
    default:
      return 'unknown';
  }
}

export class ApprovalsClient {
  private readonly tokens: ClientCredentialsTokenProvider;

  constructor(readonly config: ApprovalsConfig) {
    this.tokens = new ClientCredentialsTokenProvider(
      config.auth,
      config.requestTimeoutMs,
    );
  }

  /** Creates (or, for a repeated idempotency id, returns) an approval. */
  async createApproval(
    request: ApprovalRequestCreate,
  ): Promise<{ record: ApprovalRecord; created: boolean }> {
    const res = await this.request('POST', '/approvals', request);
    const { text, body } = await readResponseBody(res);
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(
        `Approval request failed (${res.status}): ${text.slice(0, 1000)}`,
      );
    }
    return { record: body as ApprovalRecord, created: res.status === 201 };
  }

  async updateApproval(
    id: number,
    update: Partial<
      Pick<ApprovalRequestCreate, 'callback_url' | 'callback_method' | 'data'>
    >,
  ): Promise<ApprovalRecord> {
    const res = await this.request('PATCH', `/approvals/${id}`, update);
    const { text, body } = await readResponseBody(res);
    if (!res.ok) {
      throw new Error(
        `Updating approval ${id} failed (${res.status}): ${text.slice(0, 500)}`,
      );
    }
    return body as ApprovalRecord;
  }

  /** Throws NotFoundError for unknown ids or ids from another source. */
  async getApproval(id: number): Promise<ApprovalRecord> {
    const res = await this.request('GET', `/approvals/${id}`);
    const { text, body } = await readResponseBody(res);
    if (res.status === 404 || res.status === 422) {
      throw new NotFoundError(`Approval ${id} not found`);
    }
    if (!res.ok) {
      throw new Error(
        `Approval lookup failed (${res.status}): ${text.slice(0, 500)}`,
      );
    }
    const record = body as ApprovalRecord;
    if (record.source !== this.config.source) {
      throw new NotFoundError(`Approval ${id} not found`);
    }
    return record;
  }

  async getAudit(id: number): Promise<ApprovalAuditEntry[]> {
    const res = await this.request('GET', `/approvals/${id}/audit`);
    if (!res.ok) {
      return [];
    }
    const { body } = await readResponseBody(res);
    return Array.isArray(body) ? (body as ApprovalAuditEntry[]) : [];
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    retried = false,
  ): Promise<Response> {
    const token = await this.tokens.getToken();
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    // A token revoked or rotated server-side: refresh once and retry.
    if (res.status === 401 && !retried) {
      this.tokens.invalidate();
      return this.request(method, path, body, true);
    }
    return res;
  }
}
