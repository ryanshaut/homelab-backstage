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

  /**
   * External approval system used by the `approval:request` /
   * `approval:verify` actions and the /api/approvals routes.
   * Disabled when baseUrl is unset.
   */
  approvals?: {
    /** Approval API base URL; requests go to <baseUrl>/approvals. */
    baseUrl?: string;
    /** `source` recorded on each approval. Defaults to "backstage". */
    source?: string;
    /**
     * Backstage backend URL as reachable by the approval system. Decision
     * callbacks go to <callbackBaseUrl>/api/approvals/callbacks/<id>/<sig>.
     * Defaults to backend.baseUrl.
     */
    callbackBaseUrl?: string;
    /**
     * HMAC secret (32+ chars) for callback URLs, continuation specs and
     * launcher grants. Required when baseUrl is set. Rotating it invalidates
     * callbacks for approvals that are still pending.
     * @visibility secret
     */
    signingSecret?: string;
    /** Per-request HTTP timeout. Defaults to 15000. */
    requestTimeoutMs?: number;
    /** OAuth2 client-credentials service account for the approval API. */
    auth?: {
      /** OIDC discovery URL (…/.well-known/openid-configuration). */
      metadataUrl?: string;
      clientId?: string;
      /** @visibility secret */
      clientSecret?: string;
    };
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
