import { createServer, IncomingMessage, request, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import type {
  AuthService,
  HttpAuthService,
  LoggerService,
} from '@backstage/backend-plugin-api';
import { MiddlewareFactory } from '@backstage/backend-defaults/rootHttpRouter';
import { ConfigReader } from '@backstage/config';
import { AuthenticationError } from '@backstage/errors';
import express from 'express';
import { computeSignature } from './client';
import { createWebhooksRouter } from './router';

type Captured = {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
};

const listen = (server: Server) =>
  new Promise<string>(resolve =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );

const close = (server: Server) =>
  new Promise<void>(resolve => server.close(() => resolve()));

const logger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  child: () => logger,
} as unknown as LoggerService;

// Test double: `x-test-principal: user:default/jane` or `service:ci`; absent = unauthenticated.
const httpAuth = {
  credentials: async (req: express.Request) => {
    const p = req.header('x-test-principal');
    if (!p) {
      throw new AuthenticationError('Missing credentials');
    }
    return p.startsWith('service:')
      ? { principal: { type: 'service', subject: p.slice(8) } }
      : { principal: { type: 'user', userEntityRef: p } };
  },
} as unknown as HttpAuthService;

const auth = {
  isPrincipal: (c: any, type: string) => c.principal.type === type,
} as unknown as AuthService;

describe('createWebhooksRouter', () => {
  let upstream: Server;
  let app: Server;
  let appUrl: string;
  let captured: Captured[];
  let upstreamHandler: (
    req: IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => void;

  const start = async (signingSecret?: string, timeoutMs = 2000) => {
    const upstreamUrl = await listen(upstream);
    const router = createWebhooksRouter({
      routing: {
        baseUrl: upstreamUrl,
        tenant: 'backstage-test',
        timeoutMs,
        signingSecret,
      },
      auth,
      httpAuth,
      logger,
    });
    router.use(
      MiddlewareFactory.create({
        config: new ConfigReader({}),
        logger,
      }).error(),
    );
    app = createServer(express().use('/api/webhooks', router));
    appUrl = `${await listen(app)}/api/webhooks`;
  };

  beforeEach(() => {
    captured = [];
    upstreamHandler = (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'wh-1' }));
    };
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        captured.push({
          method: req.method!,
          url: req.url!,
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        });
        upstreamHandler(req, res);
      });
    });
  });

  afterEach(async () => {
    await close(app);
    await close(upstream);
  });

  it('forwards to the tenant path with identity, without caller credentials', async () => {
    await start();
    const res = await fetch(`${appUrl}/infra/request-vm?version=v1`, {
      method: 'POST',
      headers: {
        'x-test-principal': 'user:default/jane',
        authorization: 'Bearer backstage-token',
        cookie: 'backstage-auth=abc',
        'x-backstage-principal': 'user:default/admin',
        'content-type': 'application/json',
        'x-custom': 'kept',
      },
      body: '{"vm":"a"}',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'wh-1' });
    expect(captured).toHaveLength(1);
    const [req] = captured;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(
      '/api/webhooks/backstage-test/infra/request-vm?version=v1',
    );
    expect(req.body).toBe('{"vm":"a"}');
    expect(req.headers['x-backstage-principal']).toBe('user:default/jane');
    expect(req.headers['x-custom']).toBe('kept');
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers.cookie).toBeUndefined();
    expect(req.headers['x-backstage-signature']).toBeUndefined();
  });

  it('identifies service callers', async () => {
    await start();
    await fetch(`${appUrl}/a/b`, {
      method: 'POST',
      headers: { 'x-test-principal': 'service:ci' },
    });
    expect(captured[0].headers['x-backstage-principal']).toBe('service:ci');
  });

  it('forwards bodies sent without a content-type', async () => {
    await start();
    await fetch(`${appUrl}/a/b`, {
      method: 'POST',
      headers: { 'x-test-principal': 'user:default/jane' },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(Buffer.from(captured[0].body).length).toBe(3);
  });

  it('rejects unauthenticated callers without contacting upstream', async () => {
    await start();
    const res = await fetch(`${appUrl}/a/b`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(captured).toHaveLength(0);
  });

  it('rejects path traversal without contacting upstream', async () => {
    await start();
    // fetch() normalizes %2E%2E client-side, so send the raw path the way
    // `curl --path-as-is` would.
    const { port } = app.address() as AddressInfo;
    const status = await new Promise<number>((resolve, reject) => {
      request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/webhooks/%2E%2E/%2E%2E',
          headers: { 'x-test-principal': 'user:default/jane' },
        },
        res => {
          res.resume();
          resolve(res.statusCode!);
        },
      )
        .on('error', reject)
        .end();
    });
    expect(status).toBe(400);
    expect(captured).toHaveLength(0);
  });

  it('returns decompressed bodies without stale encoding headers', async () => {
    upstreamHandler = (_req, res) => {
      const gz = gzipSync(JSON.stringify({ ok: true }));
      res.writeHead(201, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': gz.length,
      });
      res.end(gz);
    };
    await start();
    const res = await fetch(`${appUrl}/a/b`, {
      method: 'POST',
      headers: { 'x-test-principal': 'user:default/jane' },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.json()).toEqual({ ok: true });
  });

  it('signs requests when a secret is configured', async () => {
    await start('top-secret');
    await fetch(`${appUrl}/a/b?x=1`, {
      method: 'PUT',
      headers: { 'x-test-principal': 'user:default/jane' },
      body: 'payload',
    });
    const { headers, url, body } = captured[0];
    const timestamp = headers['x-backstage-timestamp'] as string;
    expect(timestamp).toMatch(/^\d+$/);
    expect(headers['x-backstage-signature']).toBe(
      computeSignature('top-secret', timestamp, 'PUT', url, body),
    );
  });

  it('proxies status lookups to the operator endpoint', async () => {
    upstreamHandler = (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ state: 'done' }));
    };
    await start();
    const res = await fetch(`${appUrl}/operator/wh-1/status`, {
      headers: { 'x-test-principal': 'user:default/jane', 'x-custom': 'no' },
    });
    expect(await res.json()).toEqual({ state: 'done' });
    expect(captured[0].method).toBe('GET');
    expect(captured[0].url).toBe('/api/operator/webhooks/wh-1/status');
    expect(captured[0].headers['x-custom']).toBeUndefined();
    expect(captured[0].headers['x-backstage-principal']).toBe(
      'user:default/jane',
    );
  });

  it('returns 504 when upstream times out', async () => {
    upstreamHandler = () => {
      // never respond
    };
    await start(undefined, 200);
    const res = await fetch(`${appUrl}/a/b`, {
      method: 'POST',
      headers: { 'x-test-principal': 'user:default/jane' },
    });
    expect(res.status).toBe(504);
    upstream.closeAllConnections();
  });
});
