/*
 * Homelab Backstage — backend entry point
 *
 * Uses the Backstage "new backend system" (createBackend + backend.add).
 * Each backend.add() call registers a plugin or module. See:
 * https://backstage.io/docs/backend-system/building-backends/index
 */
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

type ImportedFeature = {
  $$type?: string;
  default?: ImportedFeature;
};

const loadFeature = async (
  featurePromise: Promise<ImportedFeature>,
): Promise<ImportedFeature> => {
  const loaded = await featurePromise;
  const first = loaded?.default ?? loaded;
  return first?.$$type ? first : first?.default ?? first;
};

const addFeature = (featurePromise: Promise<ImportedFeature>) => {
  backend.add(loadFeature(featurePromise));
};

// ── Core framework plugins ──────────────────────────────────────────────────

addFeature(import('@backstage/plugin-app-backend'));
addFeature(import('@backstage/plugin-proxy-backend'));

// ── Scaffolder ──────────────────────────────────────────────────────────────

addFeature(import('@backstage/plugin-scaffolder-backend'));
addFeature(import('@backstage/plugin-scaffolder-backend-module-github'));
addFeature(
  import('@backstage/plugin-scaffolder-backend-module-notifications'),
);

// ── TechDocs ────────────────────────────────────────────────────────────────

addFeature(import('@backstage/plugin-techdocs-backend'));

// ── Auth ────────────────────────────────────────────────────────────────────

addFeature(import('@backstage/plugin-auth-backend'));

// OIDC provider — used for Keycloak sign-in.
// Configured in app-config.yaml under auth.providers.oidc.
addFeature(import('@backstage/plugin-auth-backend-module-oidc-provider'));

// Guest provider — only active in development (see app-config.yaml).
addFeature(import('@backstage/plugin-auth-backend-module-guest-provider'));

// ── Catalog ─────────────────────────────────────────────────────────────────

addFeature(import('@backstage/plugin-catalog-backend'));
addFeature(
  import('@backstage/plugin-catalog-backend-module-scaffolder-entity-model'),
);
addFeature(import('@backstage/plugin-catalog-backend-module-logs'));

// Keycloak catalog sync — imports Users and Groups from the configured
// Keycloak realm on a schedule. Requires the `keycloak:` block in
// app-config.yaml. See docs/keycloak.md for details.
addFeature(
  import('@backstage-community/plugin-catalog-backend-module-keycloak'),
);

// ── Permissions ─────────────────────────────────────────────────────────────

addFeature(import('@backstage/plugin-permission-backend'));
addFeature(
  import('@backstage/plugin-permission-backend-module-allow-all-policy'),
);

// ── Search ──────────────────────────────────────────────────────────────────

addFeature(import('@backstage/plugin-search-backend'));
addFeature(import('@backstage/plugin-search-backend-module-pg'));
addFeature(import('@backstage/plugin-search-backend-module-catalog'));
addFeature(import('@backstage/plugin-search-backend-module-techdocs'));

// ── Kubernetes ──────────────────────────────────────────────────────────────

addFeature(import('@backstage/plugin-kubernetes-backend'));

// ── Notifications / Signals ─────────────────────────────────────────────────

addFeature(import('@backstage/plugin-notifications-backend'));
addFeature(import('@backstage/plugin-signals-backend'));

// ── Kafka ───────────────────────────────────────────────────────────────────
// Exposes Kafka topic and consumer-group info through the Backstage API.
// Frontend uses @backstage-community/plugin-kafka on the entity page.
// Configured in app-config.yaml under kafka.clusters. See docs/kafka.md.
addFeature(import('@backstage-community/plugin-kafka-backend'));

// ── MCP Actions ─────────────────────────────────────────────────────────────

addFeature(import('@backstage/plugin-mcp-actions-backend'));

backend.start();
