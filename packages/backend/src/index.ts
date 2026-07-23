/*
 * Homelab Backstage — backend entry point
 *
 * Uses the Backstage "new backend system" (createBackend + backend.add).
 * Each backend.add() call registers a plugin or module. See:
 * https://backstage.io/docs/backend-system/building-backends/index
 */
import { createBackend } from '@backstage/backend-defaults';
import { scaffolderWebhookActionsModule } from './modules/scaffolderWebhookActions';
import { webhooksModule } from './modules/webhooks';

const backend = createBackend();

backend.add(webhooksModule);
backend.add(scaffolderWebhookActionsModule);

// ── Core framework plugins ──────────────────────────────────────────────────

backend.add(import('@backstage/plugin-app-backend'));
backend.add(import('@backstage/plugin-proxy-backend'));

// ── Scaffolder ──────────────────────────────────────────────────────────────

backend.add(import('@backstage/plugin-scaffolder-backend'));
backend.add(import('@backstage/plugin-scaffolder-backend-module-github'));
backend.add(
	import('@backstage/plugin-scaffolder-backend-module-notifications'),
);

// ── TechDocs ────────────────────────────────────────────────────────────────

backend.add(import('@backstage/plugin-techdocs-backend'));

// ── Auth ────────────────────────────────────────────────────────────────────

backend.add(import('@backstage/plugin-auth-backend'));

// OIDC provider — used for Keycloak sign-in.
// Configured in app-config.yaml under auth.providers.oidc.
backend.add(import('@backstage/plugin-auth-backend-module-oidc-provider'));

// Guest provider remains installed but disabled by config.
backend.add(import('@backstage/plugin-auth-backend-module-guest-provider'));

// ── Catalog ─────────────────────────────────────────────────────────────────

backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(import('@backstage/plugin-catalog-backend-module-github'));
backend.add(
  import('@backstage/plugin-catalog-backend-module-scaffolder-entity-model'),
);
backend.add(import('@backstage/plugin-catalog-backend-module-logs'));
backend.add(
	import('@backstage-community/plugin-catalog-backend-module-keycloak'),
);

// ── Permissions ─────────────────────────────────────────────────────────────

backend.add(import('@backstage/plugin-permission-backend'));
backend.add(
  import('@backstage/plugin-permission-backend-module-allow-all-policy'),
);

// ── Search ──────────────────────────────────────────────────────────────────

backend.add(import('@backstage/plugin-search-backend'));
backend.add(import('@backstage/plugin-search-backend-module-pg'));
backend.add(import('@backstage/plugin-search-backend-module-catalog'));
backend.add(import('@backstage/plugin-search-backend-module-techdocs'));

// ── Kubernetes ──────────────────────────────────────────────────────────────

backend.add(import('@backstage/plugin-kubernetes-backend'));

// ── Notifications / Signals ─────────────────────────────────────────────────

backend.add(import('@backstage/plugin-notifications-backend'));
backend.add(import('@backstage/plugin-signals-backend'));

// ── MCP Actions ─────────────────────────────────────────────────────────────

backend.add(import('@backstage/plugin-mcp-actions-backend'));

backend.start();
