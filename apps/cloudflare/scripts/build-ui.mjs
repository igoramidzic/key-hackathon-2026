// Builds the five UIs into ./public for the Worker: the control panel at the root and each
// system's UI under its path prefix (vite --base /<name>/).
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../public');
const uis = [
  ['@sim/control-panel', '/', out],
  ['@sim/logs-web', '/logs/', resolve(out, 'logs')],
  ['@sim/servicenow-web', '/servicenow/', resolve(out, 'servicenow')],
  ['@sim/gitlab-web', '/gitlab/', resolve(out, 'gitlab')],
  ['@sim/teams-web', '/teams/', resolve(out, 'teams')],
];

rmSync(out, { recursive: true, force: true });
for (const [pkg, base, outDir] of uis) {
  console.log(`building ${pkg} → ${base}`);
  execFileSync(
    'pnpm',
    [
      '--silent',
      '--filter',
      pkg,
      'exec',
      'vite',
      'build',
      '--base',
      base,
      '--outDir',
      outDir,
      '--emptyOutDir',
      '--logLevel',
      'warn',
    ],
    { stdio: 'inherit' },
  );
}
