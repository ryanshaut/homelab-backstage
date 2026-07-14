import { coreServices, createBackendModule } from '@backstage/backend-plugin-api';
import express from 'express';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export const webhooksModule = createBackendModule({
  pluginId: 'app',
  moduleId: 'webhooks-router',
  register(reg) {
    reg.registerInit({
      deps: {
        rootConfig: coreServices.rootConfig,
        rootHttpRouter: coreServices.rootHttpRouter,
        httpAuth: coreServices.httpAuth,
        logger: coreServices.rootLogger,
      },
      async init({ rootConfig, rootHttpRouter, httpAuth, logger }) {
        const configuredBaseUrl = rootConfig.getOptionalString('webhooks.baseUrl');
        const targetBaseUrl = (configuredBaseUrl ?? 'http://localhost:3001/api/webhooks').replace(/\/$/, '');

        const configuredTenant = rootConfig.getOptionalString('webhooks.tenant');
        const authEnv = rootConfig.getOptionalString('auth.environment') ?? 'development';
        const tenant = configuredTenant ?? `backstage-${authEnv}`;

        const router = express.Router();

        // Use a raw body to preserve payload bytes and content-type for pass-through.
        router.use(express.raw({ type: '*/*', limit: '20mb' }));

        router.all('/:app/:event', async (req, res) => {
          try {
            await httpAuth.credentials(req, { allowLimitedAccess: true });

            const app = encodeURIComponent(req.params.app);
            const event = encodeURIComponent(req.params.event);
            const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
            const targetUrl = `${targetBaseUrl}/${encodeURIComponent(tenant)}/${app}/${event}${search}`;

            const headers = new Headers();
            for (const [name, value] of Object.entries(req.headers)) {
              const lower = name.toLowerCase();
              if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'host') {
                continue;
              }
              if (value === undefined) {
                continue;
              }
              if (Array.isArray(value)) {
                for (const v of value) {
                  headers.append(name, v);
                }
              } else {
                headers.set(name, value);
              }
            }

            const hasBody = !['GET', 'HEAD'].includes(req.method.toUpperCase());
            const body = hasBody ? (req.body as Buffer | undefined) : undefined;

            const upstream = await fetch(targetUrl, {
              method: req.method,
              headers,
              body,
              redirect: 'manual',
            });

            res.status(upstream.status);
            upstream.headers.forEach((value, name) => {
              if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
                res.setHeader(name, value);
              }
            });

            const responseBody = Buffer.from(await upstream.arrayBuffer());
            res.send(responseBody);
          } catch (error) {
            logger.error('Webhook proxy request failed', {
              error: error instanceof Error ? error : new Error(String(error)),
              path: req.path,
              method: req.method,
            });
            res.status(502).json({ error: 'Webhook proxy request failed' });
          }
        });

        rootHttpRouter.use('/api/webhooks', router);
        logger.info(`Webhook proxy enabled at /api/webhooks/:app/:event -> ${targetBaseUrl}/${tenant}/:app/:event`);
      },
    });
  },
});
