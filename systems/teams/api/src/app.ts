import { createApi } from '@sim/api-kit';
import { getStore, registerRoutes, SERVICE } from './routes';

export { SERVICE };

/** The Teams REST API as a Hono app (no port binding): used by the Node and Worker hosts. */
export function createTeamsApp() {
  const app = createApi({ service: SERVICE, stats: () => getStore().stats() });
  registerRoutes(app);
  return app;
}
