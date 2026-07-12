import { createApp } from '@backstage/frontend-defaults';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
import { navModule } from './modules/nav';

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
  ],
});
