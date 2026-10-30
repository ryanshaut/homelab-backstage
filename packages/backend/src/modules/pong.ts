import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';

export const PongPlugin = createBackendPlugin({
  pluginId: 'pong',
  register(env) {
    env.registerInit({
      deps: {
        scheduler: coreServices.scheduler,
      },
      async init({ scheduler }) {
        await scheduler.scheduleTask({
          frequency: { minutes: 1 },
          timeout: { seconds: 30 },
          id: 'ping',
          fn: async () => {
            
            // env var NTFY_DEMO_URL is not empty
            if (process.env.NTFY_DEMO_URL) {
              console.log('Posting pong message to ntfy server');
              
              await fetch(process.env.NTFY_DEMO_URL, {
                method: 'POST',
                body: 'pong',
              });
            }
          },
        });
      },
    });
  },
});