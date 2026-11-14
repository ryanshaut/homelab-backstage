/*
 * Homelab Backstage — backend entry point
 *
 * Uses the Backstage "new backend system" (createBackend + backend.add).
 * Each backend.add() call registers a plugin or module. See:
 * https://backstage.io/docs/backend-system/building-backends/index
 */
import { createBackend } from '@backstage/backend-defaults';
import { keycloakAuthModule } from './modules/keycloakAuth';
import { permissionPolicyModule } from './modules/permissionPolicy';
import { scaffolderWebhookActionsModule } from './modules/scaffolderWebhookActions';
import webhooksPlugin from './plugins/webhooks';

const backend = createBackend();

// ── Webhooks ────────────────────────────────────────────────────────────────
// /api/webhooks pass-through + status lookup, and the webhook:* actions.

backend.add(webhooksPlugin);
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

// OIDC provider for Keycloak sign-in (replaces the stock oidc-provider module
// to add the keycloakIdMatchingUserEntityAnnotation resolver).
// Configured in app-config.yaml under auth.providers.oidc.
backend.add(keycloakAuthModule);

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
// Allow-all except template runs, which can be limited to
// permission.templateRunnerGroups.
backend.add(permissionPolicyModule);

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
