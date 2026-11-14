import { createBackendModule } from '@backstage/backend-plugin-api';
import {
  authProvidersExtensionPoint,
  createOAuthProviderFactory,
  createSignInResolverFactory,
  OAuthAuthenticatorResult,
  SignInInfo,
} from '@backstage/plugin-auth-node';
import {
  oidcAuthenticator,
  oidcSignInResolvers,
  OidcAuthResult,
} from '@backstage/plugin-auth-backend-module-oidc-provider';

/** Annotation the Keycloak catalog provider stamps on every User entity. */
const KEYCLOAK_ID_ANNOTATION = 'keycloak.org/id';

/**
 * Signs in the catalog User whose `keycloak.org/id` annotation equals the
 * OIDC `sub` claim (the Keycloak user ID).
 *
 * Unlike email matching, this can't be hijacked by a user changing their
 * email in Keycloak, and unlike username matching it survives renames.
 * Requires the user to have been synced by the keycloakOrg catalog provider.
 */
export const keycloakIdMatchingUserEntityAnnotation =
  createSignInResolverFactory({
    create() {
      return async (
        info: SignInInfo<OAuthAuthenticatorResult<OidcAuthResult>>,
        ctx,
      ) => {
        const sub = info.result.fullProfile.userinfo.sub;
        if (!sub) {
          throw new Error('OIDC userinfo is missing the sub claim');
        }
        return ctx.signInWithCatalogUser({
          annotations: { [KEYCLOAK_ID_ANNOTATION]: sub },
        });
      };
    },
  });

/**
 * Replaces @backstage/plugin-auth-backend-module-oidc-provider: same `oidc`
 * provider and built-in resolvers, plus `keycloakIdMatchingUserEntityAnnotation`.
 */
export const keycloakAuthModule = createBackendModule({
  pluginId: 'auth',
  moduleId: 'keycloak-oidc-provider',
  register(reg) {
    reg.registerInit({
      deps: { providers: authProvidersExtensionPoint },
      async init({ providers }) {
        providers.registerProvider({
          providerId: 'oidc',
          factory: createOAuthProviderFactory({
            authenticator: oidcAuthenticator,
            signInResolverFactories: {
              ...oidcSignInResolvers,
              keycloakIdMatchingUserEntityAnnotation,
            },
          }),
        });
      },
    });
  },
});
