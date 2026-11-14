/*
 * Shared routing + transport for the generic webhook backend.
 *
 * Used by the `webhooks` backend plugin (HTTP pass-through and status lookup)
 * and by the `webhook:*` scaffolder actions, so URL building, header hygiene,
 * request signing and timeouts behave identically everywhere.
 *
 * Upstream layout (owned by the webhook backend, not Backstage):
 *   <baseUrl>/api/webhooks/<tenant>/<app>/<event>[/<id>]
 *   <baseUrl>/api/operator/webhooks/<id>/status
 */
import { createHmac } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Config } from '@backstage/config';
import { InputError } from '@backstage/errors';

const DEFAULT_BASE_URL = 'http://localhost:3001';
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Allowed characters for tenant/app/event/id path segments. Must start with
 * an alphanumeric, which also rules out `.` and `..` (path traversal once
 * fetch normalizes the URL).
 */
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Prefix for headers Backstage sets itself; never accepted from callers. */
export const BACKSTAGE_HEADER_PREFIX = 'x-backstage-';
export const PRINCIPAL_HEADER = 'x-backstage-principal';
export const TASK_ID_HEADER = 'x-backstage-task-id';
export const TIMESTAMP_HEADER = 'x-backstage-timestamp';
export const SIGNATURE_HEADER = 'x-backstage-signature';

const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

/**
 * Request headers never forwarded upstream:
 * - hop-by-hop headers and `host`
 * - Backstage credentials (`authorization`, `cookie`)
 * - framing/encoding headers that fetch recomputes or would mismatch the body
 */
const STRIPPED_REQUEST_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  'host',
  'authorization',
  'cookie',
  'content-length',
  'accept-encoding',
  'expect',
]);

/**
 * Response headers never copied back to the caller. fetch transparently
 * decompresses bodies, so upstream content-encoding/content-length no longer
 * describe the bytes we send.
 */
const STRIPPED_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  'content-encoding',
  'content-length',
  'set-cookie',
]);

export type WebhookRouting = {
  /** Upstream origin (+ optional path prefix), without trailing `/api/webhooks`. */
  baseUrl: string;
  tenant: string;
  timeoutMs: number;
  signingSecret?: string;
};

export function validateSegment(value: string, name: string): string {
  if (!SEGMENT_PATTERN.test(value)) {
    throw new InputError(
      `Invalid webhook ${name} '${value}': must match ${SEGMENT_PATTERN}`,
    );
  }
  return value;
}

/**
 * Reads an optional string, treating "" as unset. An env var substituted as
 * an empty string would otherwise make getOptionalString throw at startup.
 */
function readOptionalString(config: Config, key: string): string | undefined {
  const value = config.getOptional(key);
  if (value === undefined || value === '') {
    return undefined;
  }
  return config.getString(key);
}

export function readWebhookRouting(config: Config): WebhookRouting {
  const rawBaseUrl =
    readOptionalString(config, 'webhooks.baseUrl') ?? DEFAULT_BASE_URL;
  const baseUrl = rawBaseUrl
    .replace(/\/+$/, '')
    .replace(/\/api\/webhooks$/, '');

  const tenant = readOptionalString(config, 'webhooks.tenant');
  if (!tenant) {
    throw new Error(
      'webhooks.tenant must be set (e.g. backstage-production) so webhook routing is explicit per environment',
    );
  }
  validateSegment(tenant, 'tenant');

  return {
    baseUrl,
    tenant,
    timeoutMs:
      config.getOptionalNumber('webhooks.timeoutMs') ?? DEFAULT_TIMEOUT_MS,
    signingSecret: readOptionalString(config, 'webhooks.signingSecret'),
  };
}

type QueryInput =
  | URLSearchParams
  | Record<string, string | number | boolean>
  | undefined;

function toQueryString(query: QueryInput): string {
  if (!query) {
    return '';
  }
  const params =
    query instanceof URLSearchParams
      ? query
      : new URLSearchParams(
          Object.entries(query).map(([k, v]) => [k, String(v)]),
        );
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function buildEventUrl(
  routing: WebhookRouting,
  app: string,
  event: string,
  query?: QueryInput,
): string {
  validateSegment(app, 'app');
  validateSegment(event, 'event');
  return `${routing.baseUrl}/api/webhooks/${
    routing.tenant
  }/${app}/${event}${toQueryString(query)}`;
}

export function buildResourceUrl(
  routing: WebhookRouting,
  app: string,
  event: string,
  id: string,
): string {
  return `${buildEventUrl(routing, app, event)}/${encodeURIComponent(id)}`;
}

export function buildStatusUrl(routing: WebhookRouting, id: string): string {
  validateSegment(id, 'id');
  return `${routing.baseUrl}/api/operator/webhooks/${id}/status`;
}

/** Copies caller headers minus credentials, hop-by-hop and reserved headers. */
export function filterRequestHeaders(
  incoming: IncomingHttpHeaders | Record<string, string>,
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if (
      value === undefined ||
      STRIPPED_REQUEST_HEADERS.has(lower) ||
      lower.startsWith(BACKSTAGE_HEADER_PREFIX)
    ) {
      continue;
    }
    for (const v of Array.isArray(value) ? value : [value]) {
      headers.append(name, v);
    }
  }
  return headers;
}

export function filterResponseHeaders(upstream: Headers): [string, string][] {
  const result: [string, string][] = [];
  upstream.forEach((value, name) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) {
      result.push([name, value]);
    }
  });
  return result;
}

/**
 * HMAC-SHA256 over `v1:<timestamp>:<METHOD>:<path+query>:<body>`, hex encoded.
 * Upstream verifies by recomputing with the shared secret and rejecting stale
 * timestamps. Exported so tests (and the upstream implementation) can match.
 */
export function computeSignature(
  secret: string,
  timestamp: string,
  method: string,
  pathAndQuery: string,
  body: Uint8Array | string | undefined,
): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(`v1:${timestamp}:${method.toUpperCase()}:${pathAndQuery}:`);
  if (body !== undefined) {
    hmac.update(body);
  }
  return `sha256=${hmac.digest('hex')}`;
}

export type SendWebhookOptions = {
  method: string;
  headers: Headers;
  body?: Uint8Array | string;
  signal?: AbortSignal;
};

/**
 * Sends a request to the webhook backend with signing (when configured), a
 * timeout, and no redirect following.
 */
export async function sendWebhook(
  routing: WebhookRouting,
  url: string,
  options: SendWebhookOptions,
): Promise<Response> {
  const method = options.method.toUpperCase();
  const body = ['GET', 'HEAD'].includes(method) ? undefined : options.body;
  const headers = new Headers(options.headers);

  if (routing.signingSecret) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const { pathname, search } = new URL(url);
    headers.set(TIMESTAMP_HEADER, timestamp);
    headers.set(
      SIGNATURE_HEADER,
      computeSignature(
        routing.signingSecret,
        timestamp,
        method,
        `${pathname}${search}`,
        body,
      ),
    );
  }

  const timeout = AbortSignal.timeout(routing.timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;

  return fetch(url, { method, headers, body, signal, redirect: 'manual' });
}

export function isTimeoutError(error: unknown): boolean {
  // fetch rejects with a DOMException, which is not always `instanceof Error`
  // across realms, so match on the name only.
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'TimeoutError'
  );
}

/** Parses a response body as JSON when possible, else returns the text. */
export async function readResponseBody(
  response: Response,
): Promise<{ text: string; body: unknown }> {
  const text = await response.text();
  if (!text) {
    return { text, body: undefined };
  }
  try {
    return { text, body: JSON.parse(text) };
  } catch {
    return { text, body: text };
  }
}

export function extractWebhookId(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'id' in body) {
    const id = (body as { id?: unknown }).id;
    if (typeof id === 'string' && SEGMENT_PATTERN.test(id)) {
      return id;
    }
  }
  return undefined;
}
