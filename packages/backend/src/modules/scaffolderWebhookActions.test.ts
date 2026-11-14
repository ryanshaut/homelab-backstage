import { requesterRef } from './scaffolderWebhookActions';

describe('requesterRef', () => {
  it('uses the signed-in user when there is one, ignoring the secret', () => {
    expect(
      requesterRef({
        user: { ref: 'user:default/jane' },
        secrets: { approvalRequestedBy: 'user:default/admin' },
      }),
    ).toBe('user:default/jane');
  });

  it('uses the launcher secret for service-started tasks', () => {
    // The scaffolder sets user to { ref: undefined } for service-created tasks.
    expect(
      requesterRef({
        user: { ref: undefined },
        secrets: { approvalRequestedBy: 'user:default/jane' },
      }),
    ).toBe('user:default/jane');
    expect(requesterRef({ secrets: {} })).toBeUndefined();
  });
});
