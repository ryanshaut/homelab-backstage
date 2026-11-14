import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { MiddlewareFactory } from '@backstage/backend-defaults/rootHttpRouter';
import { notificationService } from '@backstage/plugin-notifications-node';
import { ApprovalsClient, readApprovalsConfig } from './client';
import { ContinuationLauncher, ScaffolderTaskLauncher } from './launcher';
import { createApprovalsRouter } from './router';
import { ContinuationStore } from './store';

/**
 * `approvals` backend plugin, served at /api/approvals.
 *
 * Receives decision callbacks from the approval system and starts the
 * approved continuation template ("back half") as a new scaffolder task.
 * Also serves approval status to the frontend.
 */
export const approvalsPlugin = createBackendPlugin({
  pluginId: 'approvals',
  register(env) {
    env.registerInit({
      deps: {
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        httpRouter: coreServices.httpRouter,
        database: coreServices.database,
        auth: coreServices.auth,
        discovery: coreServices.discovery,
        notifications: notificationService,
      },
      async init({
        config,
        logger,
        httpRouter,
        database,
        auth,
        discovery,
        notifications,
      }) {
        const approvalsConfig = readApprovalsConfig(config);
        if (!approvalsConfig) {
          logger.info('approvals.baseUrl is not set; approvals are disabled');
          return;
        }

        const approvals = new ApprovalsClient(approvalsConfig);
        const store = await ContinuationStore.create(database);
        const launcher = new ContinuationLauncher({
          approvals,
          store,
          tasks: new ScaffolderTaskLauncher(auth, discovery),
          logger,
          notify: (recipientRef, payload) =>
            notifications.send({
              recipients: { type: 'entity', entityRef: recipientRef },
              payload: { ...payload, topic: 'approvals' },
            }),
        });

        const router = createApprovalsRouter({ approvals, store, launcher });
        router.use(MiddlewareFactory.create({ config, logger }).error());
        httpRouter.use(router);
        // The approval system has no Backstage credentials; callback URLs are
        // authenticated by the HMAC signature in the path instead.
        httpRouter.addAuthPolicy({
          path: '/callbacks',
          allow: 'unauthenticated',
        });

        logger.info(
          `Approvals enabled: ${approvalsConfig.baseUrl} (source=${approvalsConfig.source}), callbacks via ${approvalsConfig.callbackBaseUrl}/api/approvals/callbacks`,
        );
      },
    });
  },
});
