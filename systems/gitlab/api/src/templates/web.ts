// biome-ignore-all lint/suspicious/noTemplateCurlyInString: generated source code contains literal ${...} placeholders
import { type Knobs, lines, type RepoContext } from './context';

type Files = Record<string, string>;

function packageJson(ctx: RepoContext, k: Knobs): string {
  const pkg = {
    name: `@keybank/${ctx.repo.name}`,
    version: k.version,
    private: true,
    type: 'module',
    scripts: {
      dev: 'vite',
      build: 'tsc -b && vite build',
      preview: 'vite preview',
      lint: 'eslint . --max-warnings=0',
      test: 'vitest run',
    },
    dependencies: {
      '@tanstack/react-query': `^${k.deps['@tanstack/react-query']}`,
      react: `^${k.deps.react}`,
      'react-dom': `^${k.deps.react}`,
      'react-router-dom': `^${k.deps['react-router-dom']}`,
    },
    devDependencies: {
      '@testing-library/react': '^16.1.0',
      '@types/react': '^18.3.12',
      '@types/react-dom': '^18.3.1',
      '@vitejs/plugin-react': '^4.3.4',
      jsdom: '^25.0.1',
      typescript: `^${k.deps.typescript}`,
      vite: `^${k.deps.vite}`,
      vitest: `^${k.deps.vitest}`,
    },
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function viteConfig(ctx: RepoContext): string {
  const own = ctx.upstreams.find((u) => u.tla === ctx.tla);
  return lines(
    "import react from '@vitejs/plugin-react';",
    "import { defineConfig } from 'vite';",
    '',
    'export default defineConfig({',
    '  plugins: [react()],',
    '  server: {',
    '    port: 5173,',
    '    proxy: {',
    own ? `      '/api': '${own.baseUrl}',` : "      '/api': 'http://localhost:8080',",
    '    },',
    '  },',
    "  test: { environment: 'jsdom' },",
    '});',
    '',
  );
}

function apiClient(ctx: RepoContext, k: Knobs): string {
  const ath = ctx.upstreams.find((u) => u.tla === 'ATH');
  return lines(
    '/** Thin fetch wrapper: adds the bearer token, a timeout and JSON handling. */',
    "const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/api';",
    `const TIMEOUT_MS = ${k.timeouts[ctx.upstreams[0]?.tla ?? '']?.readMs ?? 5000};`,
    ath && `const AUTH_URL = import.meta.env.VITE_AUTH_URL ?? '${ath.baseUrl}';`,
    '',
    'export class ApiError extends Error {',
    '  constructor(',
    '    readonly status: number,',
    '    message: string,',
    '  ) {',
    '    super(message);',
    '  }',
    '}',
    '',
    "let token = sessionStorage.getItem('kb_token') ?? '';",
    '',
    'export function setToken(value: string) {',
    '  token = value;',
    "  sessionStorage.setItem('kb_token', value);",
    '}',
    '',
    'export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {',
    '  const res = await fetch(`${API_BASE}${path}`, {',
    '    ...init,',
    '    headers: {',
    "      'content-type': 'application/json',",
    '      authorization: `Bearer ${token}`,',
    k.features.requestIdHeader && "      'x-request-id': crypto.randomUUID(),",
    '      ...init.headers,',
    '    },',
    '    signal: AbortSignal.timeout(TIMEOUT_MS),',
    '  });',
    '  if (res.status === 401) {',
    ath
      ? '    window.location.assign(`${AUTH_URL}/oauth2/authorize?redirect_uri=${encodeURIComponent(window.location.href)}`);'
      : "    window.location.assign('/login');",
    '  }',
    '  if (!res.ok) throw new ApiError(res.status, await res.text());',
    '  return res.json() as Promise<T>;',
    '}',
    '',
  );
}

function resourceApi(ctx: RepoContext, k: Knobs): string {
  const r = ctx.resource;
  return lines(
    "import { api } from './client';",
    '',
    `export interface ${r.pascal} {`,
    '  id: string;',
    '  reference: string;',
    '  status: string;',
    ctx.amountField && '  amount: number;',
    '  createdAt: string;',
    '}',
    '',
    `export const PAGE_SIZE = ${Math.min(50, k.maxPageSize)};`,
    '',
    `export function list${r.pascal}s(page = 0) {`,
    `  return api<${r.pascal}[]>(\`/v1/${r.pluralKebab}?page=\${page}&pageSize=\${PAGE_SIZE}\`);`,
    '}',
    '',
    `export function get${r.pascal}(id: string) {`,
    `  return api<${r.pascal}>(\`/v1/${r.pluralKebab}/\${encodeURIComponent(id)}\`);`,
    '}',
    '',
  );
}

function listPage(ctx: RepoContext, k: Knobs): string {
  const r = ctx.resource;
  return lines(
    "import { useQuery } from '@tanstack/react-query';",
    "import { Link } from 'react-router-dom';",
    `import { list${r.pascal}s } from '../api/${r.kebab}';`,
    '',
    `export function ${r.pascal}List() {`,
    `  const { data, isLoading, error } = useQuery({ queryKey: ['${r.kebab}'], queryFn: () => list${r.pascal}s()${k.cacheTtlSec > 0 ? `, staleTime: ${k.cacheTtlSec * 1000}` : ''} });`,
    '  if (isLoading) return <p>Loading…</p>;',
    '  if (error) return <p role="alert">Could not load records. Try again in a moment.</p>;',
    '  return (',
    '    <table>',
    '      <thead>',
    '        <tr>',
    '          <th>Reference</th>',
    '          <th>Status</th>',
    ctx.amountField && '          <th>Amount</th>',
    '          <th>Created</th>',
    '        </tr>',
    '      </thead>',
    '      <tbody>',
    '        {data?.map((row) => (',
    '          <tr key={row.id}>',
    `            <td><Link to={\`/${r.pluralKebab}/\${row.id}\`}>{row.reference}</Link></td>`,
    '            <td>{row.status}</td>',
    ctx.amountField && '            <td>{row.amount.toFixed(2)}</td>',
    '            <td>{new Date(row.createdAt).toLocaleString()}</td>',
    '          </tr>',
    '        ))}',
    '      </tbody>',
    '    </table>',
    '  );',
    '}',
    '',
  );
}

function detailPage(ctx: RepoContext): string {
  const r = ctx.resource;
  return lines(
    "import { useQuery } from '@tanstack/react-query';",
    "import { useParams } from 'react-router-dom';",
    `import { get${r.pascal} } from '../api/${r.kebab}';`,
    '',
    `export function ${r.pascal}Detail() {`,
    "  const { id = '' } = useParams();",
    `  const { data, isLoading } = useQuery({ queryKey: ['${r.kebab}', id], queryFn: () => get${r.pascal}(id) });`,
    '  if (isLoading || !data) return <p>Loading…</p>;',
    '  return (',
    '    <dl>',
    '      <dt>Reference</dt>',
    '      <dd>{data.reference}</dd>',
    '      <dt>Status</dt>',
    '      <dd>{data.status}</dd>',
    '    </dl>',
    '  );',
    '}',
    '',
  );
}

function app(ctx: RepoContext): string {
  const r = ctx.resource;
  return lines(
    "import { QueryClient, QueryClientProvider } from '@tanstack/react-query';",
    "import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';",
    `import { ${r.pascal}Detail } from './pages/${r.pascal}Detail';`,
    `import { ${r.pascal}List } from './pages/${r.pascal}List';`,
    '',
    'const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });',
    '',
    'export function App() {',
    '  return (',
    '    <QueryClientProvider client={queryClient}>',
    '      <BrowserRouter>',
    '        <header className="kb-header">',
    `          <h1>${ctx.app.name}</h1>`,
    '        </header>',
    '        <main>',
    '          <Routes>',
    `            <Route path="/" element={<Navigate to="/${r.pluralKebab}" replace />} />`,
    `            <Route path="/${r.pluralKebab}" element={<${r.pascal}List />} />`,
    `            <Route path="/${r.pluralKebab}/:id" element={<${r.pascal}Detail />} />`,
    '          </Routes>',
    '        </main>',
    '      </BrowserRouter>',
    '    </QueryClientProvider>',
    '  );',
    '}',
    '',
  );
}

const MAIN = lines(
  "import { StrictMode } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { App } from './App';",
  '',
  "createRoot(document.getElementById('root')!).render(",
  '  <StrictMode>',
  '    <App />',
  '  </StrictMode>,',
  ');',
  '',
);

const NGINX = lines(
  'server {',
  '  listen 8080;',
  '  root /usr/share/nginx/html;',
  '  location / {',
  '    try_files $uri /index.html;',
  '  }',
  '  location /assets/ {',
  '    add_header Cache-Control "public, max-age=31536000, immutable";',
  '  }',
  '}',
  '',
);

const EXTRA_TESTS: Record<string, (ctx: RepoContext) => [string, string] | null> = {
  validation: (ctx) => [
    'src/api/client.test.ts',
    lines(
      "import { describe, expect, it, vi } from 'vitest';",
      "import { api, ApiError } from './client';",
      '',
      "describe('api', () => {",
      "  it('throws ApiError on 500', async () => {",
      "    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));",
      `    await expect(api('/v1/${ctx.resource.pluralKebab}')).rejects.toBeInstanceOf(ApiError);`,
      '  });',
      '});',
      '',
    ),
  ],
  serialization: (ctx) => [
    `src/pages/${ctx.resource.pascal}List.test.tsx`,
    lines(
      "import { QueryClient, QueryClientProvider } from '@tanstack/react-query';",
      "import { render, screen } from '@testing-library/react';",
      "import { MemoryRouter } from 'react-router-dom';",
      "import { expect, it } from 'vitest';",
      `import { ${ctx.resource.pascal}List } from './${ctx.resource.pascal}List';`,
      '',
      "it('shows a loading state', () => {",
      '  render(',
      '    <QueryClientProvider client={new QueryClient()}>',
      '      <MemoryRouter>',
      `        <${ctx.resource.pascal}List />`,
      '      </MemoryRouter>',
      '    </QueryClientProvider>,',
      '  );',
      "  expect(screen.getByText('Loading…')).toBeTruthy();",
      '});',
      '',
    ),
  ],
};

export const WEB_EXTRA_TESTS = Object.keys(EXTRA_TESTS);

export function renderWeb(ctx: RepoContext, k: Knobs): Files {
  const r = ctx.resource;
  const files: Files = {
    'package.json': packageJson(ctx, k),
    'tsconfig.json': `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          jsx: 'react-jsx',
          strict: true,
          noEmit: true,
          types: ['vite/client'],
        },
        include: ['src'],
      },
      null,
      2,
    )}\n`,
    'vite.config.ts': viteConfig(ctx),
    'index.html': lines(
      '<!doctype html>',
      '<html lang="en">',
      '  <head>',
      '    <meta charset="UTF-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      `    <title>${ctx.app.name}</title>`,
      '  </head>',
      '  <body>',
      '    <div id="root"></div>',
      '    <script type="module" src="/src/main.tsx"></script>',
      '  </body>',
      '</html>',
      '',
    ),
    'nginx.conf': NGINX,
    'src/main.tsx': MAIN,
    'src/App.tsx': app(ctx),
    'src/api/client.ts': apiClient(ctx, k),
    [`src/api/${r.kebab}.ts`]: resourceApi(ctx, k),
    [`src/pages/${r.pascal}List.tsx`]: listPage(ctx, k),
    [`src/pages/${r.pascal}Detail.tsx`]: detailPage(ctx),
  };
  for (const key of k.extraTests) {
    const out = EXTRA_TESTS[key]?.(ctx);
    if (out) files[out[0]] = out[1];
  }
  return files;
}
