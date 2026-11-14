import type {
  AuthService,
  HttpAuthService,
  LoggerService,
} from '@backstage/backend-plugin-api';
import express from 'express';
import {
  buildEventUrl,
  buildStatusUrl,
  filterRequestHeaders,
  filterResponseHeaders,
  isTimeoutError,
  PRINCIPAL_HEADER,
  sendWebhook,
  validateSegment,
  WebhookRouting,
} from './client';

export type WebhooksRouterOptions = {
  routing: WebhookRouting;
  auth: AuthService;
  httpAuth: HttpAuthService;
  logger: LoggerService;
};

/**
 * Routes, mounted by the plugin at /api/webhooks:
 *
 *   GET /operator/:id/status  -> <base>/api/operator/webhooks/:id/status
 *   ANY /:app/:event          -> <base>/api/webhooks/<tenant>/:app/:event
 *
 * Callers must present Backstage user or service credentials (enforced by the
 * plugin's default auth policy, and re-checked here to get the principal).
 * Upstream receives the caller identity in `x-backstage-principal`, never the
 * caller's Backstage token or cookies.
 */
export function createWebhooksRouter(
  options: WebhooksRouterOptions,
): express.Router {
  const { routing, auth, httpAuth, logger } = options;
  const router = express.Router();

  // Always buffer the body as raw bytes so it is forwarded unmodified,
  // regardless of content-type (or lack of one).
  router.use(express.raw({ type: () => true, limit: '20mb' }));

  const principalOf = async (req: express.Request): Promise<string> => {
    const credentials = await httpAuth.credentials(req, {
      allow: ['user', 'service'],
    });
    if (auth.isPrincipal(credentials, 'user')) {
      return credentials.principal.userEntityRef;
    }
    if (auth.isPrincipal(credentials, 'service')) {
      return `service:${credentials.principal.subject}`;
    }
    throw new Error('Unsupported principal type');
  };

  const forward = async (
    res: express.Response,
    targetUrl: string,
    request: { method: string; headers: Headers; body?: Uint8Array },
    principal: string,
  ) => {
    const { method, headers, body } = request;
    headers.set(PRINCIPAL_HEADER, principal);

    try {
      const upstream = await sendWebhook(routing, targetUrl, {
        method,
        headers,
        body,
      });
      res.status(upstream.status);
      for (const [name, value] of filterResponseHeaders(upstream.headers)) {
        res.setHeader(name, value);
      }
      res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      const timedOut = isTimeoutError(error);
      logger.error('Webhook upstream request failed', {
        method,
        targetUrl,
        principal,
        timedOut,
        error: error instanceof Error ? error.message : String(error),
      });
      res
        .status(timedOut ? 504 : 502)
        .json({ error: { message: 'Webhook upstream request failed' } });
    }
  };

  router.get('/operator/:id/status', async (req, res, next) => {
    try {
      const principal = await principalOf(req);
      const targetUrl = buildStatusUrl(
        routing,
        validateSegment(req.params.id, 'id'),
      );
      // Status lookups need no caller headers beyond content negotiation.
      const headers = new Headers();
      if (req.headers.accept) {
        headers.set('accept', req.headers.accept);
      }
      await forward(res, targetUrl, { method: 'GET', headers }, principal);
    } catch (error) {
      next(error);
    }
  });

  router.all('/:app/:event', async (req, res, next) => {
    try {
      const principal = await principalOf(req);
      const queryIndex = req.originalUrl.indexOf('?');
      const query =
        queryIndex >= 0
          ? new URLSearchParams(req.originalUrl.slice(queryIndex + 1))
          : undefined;
      const targetUrl = buildEventUrl(
        routing,
        req.params.app,
        req.params.event,
        query,
      );
      await forward(
        res,
        targetUrl,
        {
          method: req.method,
          headers: filterRequestHeaders(req.headers),
          body:
            Buffer.isBuffer(req.body) && req.body.length > 0
              ? new Uint8Array(req.body)
              : undefined,
        },
        principal,
      );
    } catch (error) {
      next(error);
    }
  });

  return router;
}
