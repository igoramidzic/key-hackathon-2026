/**
 * Relatedness evidence between a failing app and an existing case, with reasons a human can read
 * (they go into the briefing). Pure functions over the dependency graph and the signals.
 *
 * | evidence                                             | weight |
 * | failing requests' traces pass through a case app/candidate | 0.50 |
 * | both sides' errors name the same upstream app        | 0.45   |
 * | the app is upstream of the case and failing          | 0.45   |
 * | direct call between the app and a case app           | 0.30   |
 * | the app calls an upstream the case's errors name     | 0.25   |
 * | same normalised message / same error type            | 0.30 / 0.20 |
 * | shares the case's top upstream candidate             | 0.20 (0.05 for hubs) |
 * | onsets within the window                             | 0.15, never on its own |
 */
import type { Case, LogSignal } from '../cases/types';
import type { DependencyGraph } from './graph';

/** Acronyms that look like TLAs but are protocol words. */
const NOT_APPS = new Set([
  'GET',
  'PUT',
  'API',
  'URL',
  'SQL',
  'JWT',
  'XML',
  'TTL',
  'UTC',
  'CPU',
  'TLS',
  'SSL',
  'DNS',
  'RPC',
  'SDK',
  'UID',
  'ETA',
  'EOD',
  'ATM',
]);
const GENERIC_TYPES = new Set(['Error', 'Exception', 'RuntimeException']);

/** Apps named in free text: a TLA as a word ("CIF profile") or a service name ("customer-profile-api"). */
export function mentionedApps(texts: string[], graph: DependencyGraph): Set<string> {
  const out = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(/\b[A-Z]{3}\b/g)) {
      const tla = m[0];
      if (!NOT_APPS.has(tla) && graph.nodes.has(tla)) out.add(tla);
    }
    for (const m of text.matchAll(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g)) {
      const tla = graph.appOfService(m[0]);
      if (tla) out.add(tla);
    }
  }
  return out;
}

/** Message with ids, numbers, uuids and quoted values replaced, for signature matching. */
export function normalizeMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/"[^"]*"|'[^']*'/g, '<q>')
    .replace(/\b[a-z_]*\d[\w-]*\b/g, '<id>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function logSignals(c: Case): LogSignal[] {
  return c.signals.filter((s): s is LogSignal => s.source === 'logs');
}

export interface CaseProfile {
  apps: Set<string>;
  named: Set<string>;
  types: Set<string>;
  patterns: Set<string>;
  candidates: string[];
  onset: number | null;
}

export function profile(c: Case, graph: DependencyGraph): CaseProfile {
  const logs = logSignals(c);
  const messages = logs.flatMap((s) => s.sample_messages);
  if (c.scope) messages.push(...c.scope.signatures.map((s) => s.message));
  return {
    apps: new Set(c.apps),
    named: mentionedApps(messages, graph),
    types: new Set(logs.flatMap((s) => s.error_types).filter((t) => !GENERIC_TYPES.has(t))),
    patterns: new Set(messages.map(normalizeMessage)),
    candidates: c.upstream_candidates.slice(0, 3).map((u) => u.tla),
    onset: c.onset_at ? Date.parse(c.onset_at) : null,
  };
}

export interface Evidence {
  score: number;
  reasons: string[];
}

export interface ScoreOptions {
  /** Apps that the signal's failing requests pass through (from trace lookups). */
  traceApps?: Set<string>;
  /** Onsets closer than this count as "same time". */
  windowMs: number;
  /** Fraction of the estate below which a shared upstream is specific evidence. */
  hubShare?: number;
}

export function scoreSignal(
  signal: LogSignal,
  c: CaseProfile,
  graph: DependencyGraph,
  opts: ScoreOptions,
): Evidence {
  const x = signal.app_tla;
  const reasons: string[] = [];
  let score = 0;
  const add = (w: number, why: string) => {
    score += w;
    reasons.push(why);
  };
  if (c.apps.has(x)) return { score: 1, reasons: [`${x} is already part of the case`] };

  const upstreamOfX = graph.upstreamOf(x, 3);
  const caseApps = [...c.apps];

  // Traces
  if (opts.traceApps) {
    const through = [...opts.traceApps].filter(
      (t) => t !== x && (c.apps.has(t) || c.candidates.includes(t)),
    );
    if (through.length) add(0.5, `failing ${x} requests share traces with ${through.join(', ')}`);
  }

  // Apps named in the errors
  const namedByX = mentionedApps(signal.sample_messages, graph);
  const shared = [...namedByX].filter(
    (u) => u !== x && (c.named.has(u) || c.apps.has(u)) && (upstreamOfX.has(u) || c.apps.has(u)),
  );
  if (shared.length) add(0.45, `errors on both sides name ${shared.join(', ')}`);
  else if (c.named.has(x)) add(0.45, `the case's errors name ${x}`);
  else if (
    c.candidates.slice(0, 1).includes(x) &&
    caseApps.every((a) => graph.upstreamOf(a, 3).has(x))
  )
    add(0.45, `${x} is upstream of every failing app in the case`);

  // Direct calls
  const used = new Set<string>(shared);
  const callers = caseApps.filter((a) => graph.up.get(a)?.has(x));
  const callees = caseApps.filter((a) => graph.up.get(x)?.has(a));
  if (callers.length || callees.length) {
    const parts = [];
    if (callees.length) parts.push(`${x} calls ${callees.slice(0, 3).join(', ')}`);
    if (callers.length)
      parts.push(`${callers.slice(0, 3).join(', ')} call${callers.length === 1 ? 's' : ''} ${x}`);
    add(0.3, parts.join('; '));
    for (const a of [...callers, ...callees]) used.add(a);
  } else if (!shared.length) {
    const namedUpstream = [...c.named].filter((u) => graph.up.get(x)?.has(u));
    if (namedUpstream.length) {
      add(0.25, `${x} calls ${namedUpstream.join(', ')}, which the case's errors name`);
      for (const u of namedUpstream) used.add(u);
    }
  }

  // Error signature
  const patterns = new Set(signal.sample_messages.map(normalizeMessage));
  const samePattern = [...patterns].some((p) => c.patterns.has(p));
  const sameType = signal.error_types.filter((t) => !GENERIC_TYPES.has(t) && c.types.has(t));
  if (samePattern) add(0.3, 'same error message');
  else if (sameType.length) add(0.2, `same error type ${sameType[0]}`);

  // Shared top upstream candidate
  const top = c.candidates[0];
  if (top && top !== x && upstreamOfX.has(top) && !used.has(top)) {
    const hub = graph.downstreamSize(top) > graph.size * (opts.hubShare ?? 0.25);
    add(hub ? 0.05 : 0.2, `shares upstream ${top}${hub ? ' (a hub most apps call)' : ''}`);
  }

  // Timing: supporting evidence only.
  if (score > 0 && c.onset !== null) {
    const gap = Math.abs(Date.parse(signal.first_seen) - c.onset);
    if (gap <= opts.windowMs) add(0.15, `started within ${Math.round(gap / 1000)}s of the case`);
  }
  return { score: Math.min(1, Math.round(score * 100) / 100), reasons };
}
