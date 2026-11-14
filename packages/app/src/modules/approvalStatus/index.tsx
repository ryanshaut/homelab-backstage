import {
  createFrontendModule,
  PageBlueprint,
} from '@backstage/frontend-plugin-api';
import AssignmentTurnedInIcon from '@material-ui/icons/AssignmentTurnedIn';

export const approvalStatusPageModule = createFrontendModule({
  pluginId: 'app',
  extensions: [
    PageBlueprint.make({
      name: 'approval-status',
      params: {
        path: '/approval-status',
        title: 'Approval Status',
        icon: <AssignmentTurnedInIcon />,
        loader: async () => {
          const { ApprovalStatusPage } = await import('./ApprovalStatusPage');
          return <ApprovalStatusPage />;
        },
      },
    }),
  ],
});
