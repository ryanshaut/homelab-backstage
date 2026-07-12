# Keycloak Integration

## Overview

Keycloak serves two roles in this deployment:

1. **Authentication** — users sign in to Backstage via OIDC using Keycloak
   as the identity provider.
2. **Catalog sync** — Keycloak users and groups are periodically imported
   into the Backstage software catalog as `User` and `Group` entities.

## Realm setup

The file `keycloak/realm-export.json` defines the `backstage` realm and is
imported automatically when Keycloak starts for the first time (via
`--import-realm` in the Docker Compose command).

### Clients

| Client ID | Purpose | Flow |
|-----------|---------|------|
| `backstage` | OIDC sign-in | Authorization Code |
| `backstage-catalog-sync` | Catalog sync | Service account / Client Credentials |

### Demo users

| Username | Password | Groups |
|----------|----------|--------|
| alice | password | platform-team |
| bob | password | platform-team |

> **Change these passwords** before using this in any shared environment.

## Configuration

All Keycloak config is driven by environment variables defined in `.env.example`.

### app-config.yaml sections

**OIDC sign-in** (`auth.providers.oidc`):

```yaml
auth:
  providers:
    oidc:
      development:
        metadataUrl: ${AUTH_OIDC_METADATA_URL}
        clientId: ${AUTH_OIDC_CLIENT_ID}
        clientSecret: ${AUTH_OIDC_CLIENT_SECRET}
        signIn:
          resolvers:
            - resolver: preferredUsernameMatchingUserEntityName
```

**Catalog sync** (`keycloak`):

```yaml
keycloak:
  baseUrl: ${KEYCLOAK_BASE_URL}
  loginRealm: ${KEYCLOAK_LOGIN_REALM}
  realm: ${KEYCLOAK_REALM}
  clientId: ${KEYCLOAK_CLIENT_ID}
  clientSecret: ${KEYCLOAK_CLIENT_SECRET}
```

## Service-account permissions

The `backstage-catalog-sync` client needs the `view-users` and `view-groups`
realm-management roles to read users and groups.  In production, grant these
via: Keycloak Admin → Clients → backstage-catalog-sync → Service Account Roles
→ realm-management → view-users, view-groups.

## Backend module

`@backstage-community/plugin-catalog-backend-module-keycloak` is registered in
`packages/backend/src/index.ts`:

```ts
backend.add(
  import('@backstage-community/plugin-catalog-backend-module-keycloak'),
);
```

The module polls Keycloak on a schedule (default: every 30 minutes) and
upserts `User`/`Group` entities into the catalog.
