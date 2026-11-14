import { ConfigReader } from '@backstage/config';
import {
  buildEventUrl,
  buildStatusUrl,
  computeSignature,
  extractWebhookId,
  filterRequestHeaders,
  filterResponseHeaders,
  readWebhookRouting,
  validateSegment,
  WebhookRouting,
} from './client';

const routing: WebhookRouting = {
  baseUrl: 'http://wh:3001',
  tenant: 'backstage-test',
  timeoutMs: 1000,
};

describe('readWebhookRouting', () => {
  it('normalizes the base URL and reads tenant', () => {
    const r = readWebhookRouting(
      new ConfigReader({
        webhooks: { baseUrl: 'http://wh:3001/api/webhooks/', tenant: 't1' },
      }),
    );
    expect(r).toEqual({
      baseUrl: 'http://wh:3001',
      tenant: 't1',
      timeoutMs: 30000,
      signingSecret: undefined,
    });
  });

  it('treats empty strings (empty env vars) as unset', () => {
    const r = readWebhookRouting(
      new ConfigReader({
        webhooks: { baseUrl: '', tenant: 't1', signingSecret: '' },
      }),
    );
    expect(r.baseUrl).toBe('http://localhost:3001');
    expect(r.signingSecret).toBeUndefined();
  });

  it('requires a tenant', () => {
    expect(() =>
      readWebhookRouting(new ConfigReader({ webhooks: { tenant: '' } })),
    ).toThrow(/webhooks.tenant must be set/);
  });

  it('rejects an invalid tenant', () => {
    expect(() =>
      readWebhookRouting(new ConfigReader({ webhooks: { tenant: '..' } })),
    ).toThrow(/Invalid webhook tenant/);
  });
});

describe('validateSegment', () => {
  it.each(['infra', 'request-vm', 'a.b', 'A_1', '550e8400-e29b-41d4'])(
    'accepts %s',
    v => expect(validateSegment(v, 'app')).toBe(v),
  );

  it.each(['..', '.', '', 'a/b', '%2e%2e', '-x', 'a b', 'a?b'])(
    'rejects %j',
    v => expect(() => validateSegment(v, 'app')).toThrow(/Invalid webhook app/),
  );
});

describe('URL building', () => {
  it('builds event URLs with query', () => {
    expect(
      buildEventUrl(routing, 'infra', 'request-vm', { version: 'v1', n: 2 }),
    ).toBe(
      'http://wh:3001/api/webhooks/backstage-test/infra/request-vm?version=v1&n=2',
    );
  });

  it('cannot escape the tenant', () => {
    expect(() => buildEventUrl(routing, '..', '..')).toThrow();
  });

  it('builds status URLs', () => {
    expect(buildStatusUrl(routing, 'abc-123')).toBe(
      'http://wh:3001/api/operator/webhooks/abc-123/status',
    );
    expect(() => buildStatusUrl(routing, '../x')).toThrow();
  });
});

describe('header filtering', () => {
  it('drops credentials, hop-by-hop, framing and reserved headers', () => {
    const headers = filterRequestHeaders({
      authorization: 'Bearer user-token',
      cookie: 'backstage-auth=x',
      host: 'backstage',
      connection: 'keep-alive',
      'content-length': '10',
      'accept-encoding': 'gzip',
      'x-backstage-principal': 'user:default/spoofed',
      'content-type': 'application/json',
      'x-custom': ['a', 'b'],
    });
    expect([...headers.keys()].sort()).toEqual(['content-type', 'x-custom']);
    expect(headers.get('x-custom')).toBe('a, b');
  });

  it('drops encoding/length/set-cookie from upstream responses', () => {
    const upstream = new Headers({
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': '42',
      'set-cookie': 'a=b',
      'x-request-id': 'r1',
    });
    expect(Object.fromEntries(filterResponseHeaders(upstream))).toEqual({
      'content-type': 'application/json',
      'x-request-id': 'r1',
    });
  });
});

describe('computeSignature', () => {
  it('is a stable HMAC over timestamp, method, path and body', () => {
    const a = computeSignature('s', '1700000000', 'post', '/p?q=1', '{"a":1}');
    expect(a).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(
      computeSignature('s', '1700000000', 'POST', '/p?q=1', '{"a":1}'),
    ).toBe(a);
    expect(
      computeSignature('s', '1700000000', 'POST', '/p?q=2', '{"a":1}'),
    ).not.toBe(a);
    expect(
      computeSignature('t', '1700000000', 'POST', '/p?q=1', '{"a":1}'),
    ).not.toBe(a);
  });
});

describe('extractWebhookId', () => {
  it('returns safe string ids only', () => {
    expect(extractWebhookId({ id: 'abc-1' })).toBe('abc-1');
    expect(extractWebhookId({ id: '../x' })).toBeUndefined();
    expect(extractWebhookId({ id: 5 })).toBeUndefined();
    expect(extractWebhookId('abc')).toBeUndefined();
  });
});
