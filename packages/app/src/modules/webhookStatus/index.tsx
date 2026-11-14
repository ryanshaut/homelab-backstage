import {
  createFrontendModule,
  PageBlueprint,
} from '@backstage/frontend-plugin-api';
import AutorenewIcon from '@material-ui/icons/Autorenew';

export const webhookStatusPageModule = createFrontendModule({
  pluginId: 'app',
  extensions: [
    PageBlueprint.make({
      name: 'webhook-status',
      params: {
        path: '/webhook-status',
        title: 'Webhook Status',
        icon: <AutorenewIcon />,
        loader: async () => {
          const { WebhookStatusPage } = await import('./WebhookStatusPage');
          return <WebhookStatusPage />;
        },
      },
    }),
  ],
});
