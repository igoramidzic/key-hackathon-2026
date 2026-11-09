import type { RepoOverlay } from '@sim/scenarios';
import type { Stack } from '@sim/world';
import { changelog, codeowners, dockerfile, gitignore, gitlabCi, readme } from './common';
import type { Knobs, RepoContext } from './context';
import { JAVA_EXTRA_TESTS, renderJava } from './java';
import { NODE_EXTRA_TESTS, renderNode } from './node';
import { PYTHON_EXTRA_TESTS, renderPython } from './python';
import { renderTerraform } from './terraform';
import { renderWeb, WEB_EXTRA_TESTS } from './web';

export * from './context';

/** Scaffolding added to `complete` overlays when the overlay lacks them. */
export const SCAFFOLD_FILES = [
  'README.md',
  'CHANGELOG.md',
  'Dockerfile',
  '.gitlab-ci.yml',
  '.gitignore',
];

export type Tree = Record<string, string>;

/** The generated codebase for a repo at a given knob state (no overlay). */
export function renderTemplate(ctx: RepoContext, k: Knobs): Tree {
  let files: Tree;
  switch (ctx.stack) {
    case 'java-spring':
      files = renderJava(ctx, k);
      break;
    case 'node-ts':
      files = renderNode(ctx, k);
      break;
    case 'python':
      files = renderPython(ctx, k);
      break;
    case 'react-web':
      files = renderWeb(ctx, k);
      break;
    case 'terraform':
      files = renderTerraform(ctx, k);
      break;
  }
  files['README.md'] = readme(ctx, k);
  files['CHANGELOG.md'] = changelog(k);
  if (ctx.stack !== 'terraform') files.Dockerfile = dockerfile(ctx, k);
  files['.gitlab-ci.yml'] = gitlabCi(ctx, k);
  files['.gitignore'] = gitignore(ctx, k);
  files['.gitlab/CODEOWNERS'] = codeowners(ctx);
  for (const doc of k.docs) files[doc.path] = doc.body;
  return files;
}

export function normalizePath(path: string): string {
  return path.replace(/^\.?\/+/, '').replace(/\/+/g, '/');
}

/** Overlay files keyed by normalized path. */
export function overlayFiles(overlay: RepoOverlay | undefined): Tree | undefined {
  if (!overlay) return undefined;
  const out: Tree = {};
  for (const [path, content] of Object.entries(overlay.files ?? {})) {
    if (typeof content === 'string') out[normalizePath(path)] = content;
  }
  return out;
}

/** The repo tree: template, with a hero overlay layered on (or replacing it when complete). */
export function renderTree(ctx: RepoContext, k: Knobs, overlay?: RepoOverlay): Tree {
  const template = renderTemplate(ctx, k);
  const files = overlayFiles(overlay);
  if (!overlay || !files) return template;
  if (overlay.complete) {
    const out: Tree = { ...files };
    for (const path of SCAFFOLD_FILES) {
      if (!(path in out) && template[path] !== undefined) out[path] = template[path]!;
    }
    return out;
  }
  return { ...template, ...files };
}

export const EXTRA_TEST_KEYS: Record<Stack, string[]> = {
  'java-spring': JAVA_EXTRA_TESTS,
  'node-ts': NODE_EXTRA_TESTS,
  python: PYTHON_EXTRA_TESTS,
  'react-web': WEB_EXTRA_TESTS,
  terraform: [],
};
