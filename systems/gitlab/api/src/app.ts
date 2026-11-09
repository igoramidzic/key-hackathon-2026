import { createApi } from '@sim/api-kit';
import { registerMiscRoutes } from './routes/misc';
import { registerMrRoutes } from './routes/mrs';
import { registerRepoRoutes } from './routes/repo';
import { configureStore, getStore } from './state';
import type { GitlabStoreOptions } from './store/store';

export const SERVICE = 'gitlab-api';

/**
 * The GitLab REST API as a Hono app (no port binding): used by the Node and Worker hosts.
 * The store seeds lazily on first use.
 */
export function createGitlabApp(options: GitlabStoreOptions = {}) {
  configureStore(options);
  const app = createApi({ service: SERVICE, stats: () => getStore().stats() });
  registerRepoRoutes(app);
  registerMrRoutes(app);
  registerMiscRoutes(app);
  return app;
}
