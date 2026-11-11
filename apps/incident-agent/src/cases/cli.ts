/** `pnpm agent cases` and `pnpm agent case <id>`: read the store, print, exit. */
import { color } from '../log';
import { hhmm } from '../util';
import type { CaseStore } from './store';
import type { Case, Phase } from './types';

const PHASE_COLOR: Partial<Record<Phase, (s: string) => string>> = {
  resolved: color.green,
  resolution_drafted: color.green,
  failed: color.red,
  abandoned: color.dim,
  detected: color.yellow,
};

function phase(p: Phase): string {
  return (PHASE_COLOR[p] ?? color.cyan)(p);
}

export function caseLinks(c: Case): [string, string][] {
  const links: [string, string][] = [];
  if (c.incident) links.push([c.incident.number, c.incident.web_url]);
  if (c.channel) links.push([`#${c.channel.name}`, c.channel.web_url]);
  if (c.fix_mr) links.push([`${c.fix_mr.project}!${c.fix_mr.iid}`, c.fix_mr.web_url]);
  if (c.change) links.push([c.change.number, c.change.web_url]);
  return links;
}

export function printCases(store: CaseStore): void {
  const cases = store.load();
  if (cases.length === 0) {
    console.log(color.dim(`No cases in ${store.casesDir}`));
    return;
  }
  for (const c of cases) {
    const apps = c.apps.join(',') || '-';
    console.log(
      `${color.bold(c.id)}  ${phase(c.phase)}  ${color.dim(c.kind)}  apps ${apps}  opened ${hhmm(c.opened_at)}`,
    );
    for (const [label, url] of caseLinks(c))
      console.log(`    ${label.padEnd(36)} ${color.dim(url)}`);
    if (c.failure) console.log(color.red(`    failed: ${c.failure.reason}`));
  }
}

export function printCase(store: CaseStore, id: string): boolean {
  store.load();
  const c =
    store.get(id) ?? store.all().find((x) => x.id.startsWith(id) || x.incident?.number === id);
  if (!c) {
    console.error(`No case ${id}`);
    return false;
  }
  console.log(
    `${color.bold(c.id)}  ${phase(c.phase)}  ${c.kind}  apps ${c.apps.join(', ') || '-'}`,
  );
  for (const [label, url] of caseLinks(c)) console.log(`  ${label.padEnd(36)} ${color.dim(url)}`);
  if (c.root_cause)
    console.log(
      `  root cause: ${c.root_cause.culprit_tla} ${c.root_cause.merge_request?.web_url ?? ''} (${Math.round(c.root_cause.confidence * 100)}%)`,
    );
  console.log('');
  for (const e of c.timeline) {
    const kind = e.kind === 'error' ? color.red(e.kind) : color.dim(e.kind);
    console.log(
      `${color.dim(e.at.slice(11, 19))} ${kind.padEnd(8)} ${e.text}${e.url ? color.dim(` ${e.url}`) : ''}`,
    );
  }
  return true;
}
