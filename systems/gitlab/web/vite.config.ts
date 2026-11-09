import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { type Connect, defineConfig, type Plugin } from 'vite';

// gitlab API (see packages/contracts/src/config.ts). Hardcoded: vite.config can't import TS packages.
const API = process.env.GITLAB_API_URL ?? 'http://localhost:4003';

// SIM_BASE=/<name>/ serves the UI under that prefix in dev, as in the single-origin build, and
// proxies `<prefix>/api` etc. to the API with the prefix stripped. Unset: base '/', as before.
const PREFIX = (process.env.SIM_BASE ?? '').replace(/\/+$/, ''); // '' or e.g. '/gitlab'
const proxy = Object.fromEntries(
  ['/api', '/admin', '/health'].map((p) => [
    `${PREFIX}${p}`,
    PREFIX ? { target: API, rewrite: (path: string) => path.slice(PREFIX.length) } : API,
  ]),
);

// The router links the app root as `<prefix>` (no slash), but Vite only serves `<prefix>/`.
const redirectBare: Connect.NextHandleFunction = (req, res, next) => {
  const url = req.url ?? '';
  if (!PREFIX || (url !== PREFIX && !url.startsWith(`${PREFIX}?`))) return next();
  res.writeHead(302, { Location: `${PREFIX}/${url.slice(PREFIX.length)}` });
  res.end();
};
const baseRedirect: Plugin = {
  name: 'sim-base-redirect',
  configureServer: (server) => void server.middlewares.use(redirectBare),
  configurePreviewServer: (server) => void server.middlewares.use(redirectBare),
};

export default defineConfig({
  base: `${PREFIX}/`,
  plugins: [react(), tailwindcss(), baseRedirect],
  server: { port: 3003, strictPort: true, proxy },
  preview: { port: 3003, proxy },
});
