export interface Config {
  /** Routing for the generic webhook backend used by the `webhooks` plugin and `webhook:*` actions. */
  webhooks?: {
    /**
     * Upstream origin of the webhook backend (a trailing /api/webhooks is ignored).
     * Defaults to http://localhost:3001. Only the backend talks to it; browsers
     * go through /api/webhooks.
     */
    baseUrl?: string;
    /** Tenant path segment, e.g. backstage-production. Required. */
    tenant: string;
    /** Upstream request timeout in milliseconds. Defaults to 30000. */
    timeoutMs?: number;
    /**
     * Shared secret for HMAC-SHA256 request signing. When set, every upstream
     * request carries x-backstage-timestamp and x-backstage-signature headers.
     * @visibility secret
     */
    signingSecret?: string;
  };

  permission?: {
    /**
     * Group entity refs (e.g. `group:default/platform-team`, or just
     * `platform-team`) whose members may run templates and scaffolder actions.
     * Unset or empty = every signed-in user.
     */
    templateRunnerGroups?: string[];
  };
}
