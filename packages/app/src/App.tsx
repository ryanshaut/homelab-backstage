import { createApp } from '@backstage/frontend-defaults';
import { OAuth2 } from '@backstage/core-app-api';
import {
  BackstageIdentityApi,
  OpenIdConnectApi,
  ProfileInfoApi,
  SessionApi,
} from '@backstage/core-plugin-api';
import { SignInPage } from '@backstage/core-components';
import {
  ApiBlueprint,
  configApiRef,
  createApiRef,
  createFrontendModule,
  discoveryApiRef,
  oauthRequestApiRef,
} from '@backstage/frontend-plugin-api';
import { SignInPageBlueprint } from '@backstage/plugin-app-react';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
import { navModule } from './modules/nav';

const keycloakAuthApiRef =
  createApiRef<
    OpenIdConnectApi & ProfileInfoApi & BackstageIdentityApi & SessionApi
  >().with({ id: 'auth.keycloak' });

const keycloakAuthApi = ApiBlueprint.make({
  name: 'keycloak-auth-api',
  params: defineParams =>
    defineParams({
      api: keycloakAuthApiRef,
      deps: {
        configApi: configApiRef,
        discoveryApi: discoveryApiRef,
        oauthRequestApi: oauthRequestApiRef,
      },
      factory: ({ configApi, discoveryApi, oauthRequestApi }) =>
        OAuth2.create({
          configApi,
          discoveryApi,
          oauthRequestApi,
          environment: configApi.getOptionalString('auth.environment'),
          provider: {
            id: 'oidc',
            title: 'Keycloak',
            icon: () => null,
          },
          defaultScopes: ['openid', 'profile', 'email'],
        }),
    }),
});

const signInPage = SignInPageBlueprint.make({
  params: {
    loader: async () => props => (
      <SignInPage
        {...props}
        provider={{
          id: 'keycloak-auth-provider',
          title: 'Keycloak',
          message: 'Sign In using Keycloak',
          apiRef: keycloakAuthApiRef,
        }}
      />
    ),
  },
});

const keycloakAuthModule = createFrontendModule({
  pluginId: 'app',
  extensions: [keycloakAuthApi, signInPage],
});

/*
 * The Backstage frontend uses the new "declarative integration" API
 * (createApp + feature flags) instead of the old AppRouter/AppSidebar
 * pattern. Plugins are loaded via their /alpha export.
 *
 * Airflow and Kafka plugins expose entity-tab extensions that are picked
 * up automatically when the corresponding entity annotations are present.
 */
export default createApp({
  features: [
    catalogPlugin,
    navModule,
    keycloakAuthModule,
  ],
});
