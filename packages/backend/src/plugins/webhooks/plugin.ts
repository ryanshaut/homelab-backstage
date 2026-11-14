import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { MiddlewareFactory } from '@backstage/backend-defaults/rootHttpRouter';
import { readWebhookRouting } from './client';
import { createWebhooksRouter } from './router';

/**
 * `webhooks` backend plugin, served at /api/webhooks.
 *
 * Being a real plugin (rather than a route on the root router) means the
 * default plugin auth policy applies: unauthenticated requests are rejected
 * before reaching the router. External systems calling in should use a static
 * token or JWKS entry under `backend.auth.externalAccess`.
 */
export const webhooksPlugin = createBackendPlugin({
  pluginId: 'webhooks',
  register(env) {
    env.registerInit({
      deps: {
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        auth: coreServices.auth,
        httpAuth: coreServices.httpAuth,
        httpRouter: coreServices.httpRouter,
      },
      async init({ config, logger, auth, httpAuth, httpRouter }) {
        const routing = readWebhookRouting(config);
        const router = createWebhooksRouter({
          routing,
          auth,
          httpAuth,
          logger,
        });
        router.use(MiddlewareFactory.create({ config, logger }).error());
        httpRouter.use(router);

        const signing = routing.signingSecret ? 'signed' : 'unsigned';
        logger.info(
          `Webhook pass-through enabled (${signing}): /api/webhooks/:app/:event -> ${routing.baseUrl}/api/webhooks/${routing.tenant}/:app/:event`,
        );
      },
    });
  },
});
