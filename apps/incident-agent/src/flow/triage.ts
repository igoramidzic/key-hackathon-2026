/**
 * Triage (#16): what is broken, for whom, since when, and how bad. Gates the first Teams message,
 * so it must be quick.
 *
 * A deterministic pass builds the ScopeReport from the logs (summarize_errors, list_log_services,
 * get_log_entry). With Claude enabled, a read-only LLM phase then checks and improves the prose,
 * severity and grouping. Log links always come from search_logs responses for the exact filter,
 * never from the model.
 */
import type { Case, HumanSignal, LogSignal, ScopeReport } from '../cases/types';
import { ScopeReport as ScopeSchema } from '../cases/types';
import { mentionedApps } from '../correlate/evidence';
import { errorMessage, hhmm, uniq } from '../util';
import {
  type Fingerprint,
  literalPhrase,
  logLink,
  messageClause,
  type Summary,
  sinceClause,
  tlaClause,
} from './logs';
import type { FlowDeps } from './steps';

const GENERIC_TYPES = new Set(['Error', 'Exception']);

function humans(c: Case): HumanSignal[] {
  return c.signals.filter((s): s is HumanSignal => s.source === 'human');
}

function logSignals(c: Case): LogSignal[] {
  return c.signals.filter((s): s is LogSignal => s.source === 'logs');
}

/**
 * Human-reported cases arrive without an app. Look for the apps behind the calls: weak signals
 * already attached, warning patterns that only started around the first call, and app names the
 * callers use ("teller" → Teller Workstation).
 */
export async function discoverApps(
  deps: FlowDeps,
  c: Case,
): Promise<{ apps: string[]; reasons: Map<string, string[]> }> {
  const graph = deps.graph();
  const calls = humans(c);
  const onset = Date.parse(c.onset_at ?? c.opened_at);
  const score = new Map<string, number>();
  const reasons = new Map<string, string[]>();
  const bump = (tla: string, by: number, why: string) => {
    score.set(tla, (score.get(tla) ?? 0) + by);
    reasons.set(tla, [...(reasons.get(tla) ?? []), why]);
  };
  for (const h of calls) if (h.app_tla) bump(h.app_tla, 3, `named on ${h.incident_number}`);
  for (const s of logSignals(c)) bump(s.app_tla, 2, `${s.reason} on ${s.service}`);

  const start = new Date(onset - 20 * 60_000).toISOString();
  const summary = await deps.mcp.call<Summary>(
    'summarize_errors',
    { severity_min: 'WARNING', start_time: start, limit: 100 },
    { caseId: c.id },
  );
  for (const fp of summary.items) {
    const fresh = Date.parse(fp.first_seen) >= onset - 12 * 60_000;
    if (fresh && fp.count >= 5)
      bump(
        fp.app_tla,
        2,
        `new pattern since ${hhmm(fp.first_seen)}: "${fp.pattern.slice(0, 80)}" ×${fp.count}`,
      );
  }

  const text = calls
    .map((h) => `${h.short_description} ${h.description}`)
    .join(' ')
    .toLowerCase();
  for (const tla of mentionedApps([text.toUpperCase(), text], graph))
    bump(tla, 1, 'named by callers');
  for (const node of graph.nodes.values()) {
    const words = node.name
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length >= 6);
    const hit = words.find((w) => text.includes(w));
    if (hit) bump(node.tla, 1, `callers mention "${hit}"`);
  }
  const apps = [...score.entries()]
    .filter(([, s]) => s >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([tla]) => tla);
  return { apps, reasons };
}

/** Deterministic ScopeReport from the logs. */
export async function heuristicScope(deps: FlowDeps, c: Case): Promise<ScopeReport> {
  const graph = deps.graph();
  const human = c.kind === 'human-reported';
  const onset = Date.parse(c.onset_at ?? c.opened_at);
  const since = new Date(onset - 5 * 60_000).toISOString();
  const linkSince = new Date(onset - 2 * 60_000).toISOString();
  const apps = c.apps;
  const severity = human ? 'WARNING' : 'ERROR';

  const summary: Summary = apps.length
    ? await deps.mcp.call<Summary>(
        'summarize_errors',
        { app_tla: apps.join(','), severity_min: severity, start_time: since, limit: 100 },
        { caseId: c.id },
      )
    : { total_matched: 0, items: [] };
  // Keep the incident's own patterns: frequent, or new since the onset.
  const incident = summary.items.filter(
    (fp) => fp.count >= 3 || Date.parse(fp.first_seen) >= onset - 60_000,
  );

  const byApp = new Map<string, Fingerprint[]>();
  for (const fp of incident) byApp.set(fp.app_tla, [...(byApp.get(fp.app_tla) ?? []), fp]);
  const affected = apps
    .map((tla) => {
      const fps = byApp.get(tla) ?? [];
      const firsts = fps.map((f) => f.first_seen).sort();
      const signalOnset = logSignals(c).find((s) => s.app_tla === tla)?.first_seen;
      return {
        tla,
        name: graph.name(tla),
        tier: graph.nodes.get(tla)?.tier ?? 3,
        services: uniq(fps.map((f) => f.service)),
        error_count: fps.reduce((n, f) => n + f.count, 0),
        onset: firsts[0] ?? signalOnset ?? c.onset_at ?? c.opened_at,
      };
    })
    .sort((a, b) => b.error_count - a.error_count);
  const scopeOnset =
    affected
      .filter((a) => a.error_count > 0)
      .map((a) => a.onset)
      .sort()[0] ??
    c.onset_at ??
    c.opened_at;

  // Signatures: the biggest patterns, one per app first.
  const ranked = [...incident].sort((a, b) => b.count - a.count);
  const picked: Fingerprint[] = [];
  for (const fp of ranked) {
    if (picked.length >= 5) break;
    if (picked.some((p) => p.app_tla === fp.app_tla) && picked.length < affected.length) continue;
    picked.push(fp);
  }
  const signatures = await Promise.all(
    picked.map(async (fp, i) => {
      let stack = '';
      if (i < 3) {
        try {
          const entry = await deps.mcp.call<{ jsonPayload?: { error?: { stack_trace?: string } } }>(
            'get_log_entry',
            { insert_id: fp.sample_insert_id },
            { caseId: c.id },
          );
          stack = (entry.jsonPayload?.error?.stack_trace ?? '').split('\n').slice(0, 4).join('\n');
        } catch {
          // a missing entry only costs us the excerpt
        }
      }
      return {
        app_tla: fp.app_tla,
        error_type: fp.error_type ?? '',
        message: fp.sample_message,
        sample_insert_id: fp.sample_insert_id,
        stack_excerpt: stack,
      };
    }),
  );

  // Links, each from a search_logs response for that exact filter.
  const linkApps = affected
    .filter((a) => a.error_count > 0)
    .slice(0, 12)
    .map((a) => a.tla);
  const log_links: ScopeReport['log_links'] = [];
  const addLink = async (label: (total: number) => string, filter: string) => {
    try {
      const link = await logLink(deps.mcp, filter, c.id);
      if (link.total > 0 || log_links.length === 0)
        log_links.push({ label: label(link.total), filter, logs_url: link.logs_url });
    } catch (err) {
      deps.log.warn(`${c.id} log link failed: ${errorMessage(err)}`);
    }
  };
  if (linkApps.length) {
    await addLink(
      (n) =>
        `${n.toLocaleString('en-US')} ${severity === 'ERROR' ? 'errors' : 'warnings'} in ${linkApps.length === 1 ? linkApps[0] : `${linkApps.length} affected apps`} since ${hhmm(linkSince)}`,
      `severity>=${severity} ${tlaClause(linkApps)} ${sinceClause(linkSince)}`,
    );
  }
  const top = ranked[0];
  if (top) {
    const phrase = literalPhrase(top.pattern, top.sample_message);
    const clause =
      top.error_type && !GENERIC_TYPES.has(top.error_type)
        ? `jsonPayload.error.type="${top.error_type}"`
        : phrase
          ? messageClause(phrase)
          : null;
    if (clause)
      await addLink(
        (n) =>
          `Top signature (${n.toLocaleString('en-US')}): ${top.error_type ?? phrase ?? top.pattern.slice(0, 60)}`,
        `severity>=${severity} ${clause} ${sinceClause(linkSince)}`,
      );
  }
  const suspect = c.upstream_candidates.find((u) => !u.failing && u.covers === u.of && u.of > 1);
  if (suspect && log_links.length < 3) {
    await addLink(
      (n) => `${suspect.tla} (shared upstream, ${n} warnings or errors)`,
      `severity>=WARNING ${tlaClause([suspect.tla])} ${sinceClause(linkSince)}`,
    );
  }

  // Severity.
  const tier1 = affected.filter((a) => a.tier === 1 && a.error_count > 0);
  const calls = humans(c);
  let errorRateMax = 0;
  if (linkApps.length) {
    try {
      const services = await deps.mcp.call<{ items: { error_rate: number }[] }>(
        'list_log_services',
        { app_tla: linkApps.join(','), start_time: new Date(onset).toISOString(), limit: 50 },
        { caseId: c.id },
      );
      errorRateMax = Math.max(0, ...services.items.map((s) => s.error_rate));
    } catch {
      // keep 0
    }
  }
  const failingApps = affected.filter((a) => a.error_count > 0).length;
  const impact: 1 | 2 | 3 =
    (tier1.length > 0 && (failingApps >= 2 || calls.length >= 2)) || failingApps >= 5
      ? 1
      : tier1.length > 0 || failingApps >= 2 || calls.length >= 2
        ? 2
        : 3;
  const urgency: 1 | 2 | 3 =
    errorRateMax >= 0.15 || failingApps >= 5 || calls.length >= 3
      ? 1
      : errorRateMax >= 0.03 || calls.length
        ? 2
        : 3;
  const severity_reason = [
    tier1.length
      ? `${tier1.length} tier-1 app${tier1.length > 1 ? 's' : ''} failing (${tier1
          .slice(0, 3)
          .map((a) => a.tla)
          .join(', ')})`
      : null,
    failingApps > 1 ? `${failingApps} apps affected` : null,
    errorRateMax ? `error rate up to ${Math.round(errorRateMax * 100)}%` : null,
    calls.length ? `${calls.length} calls from staff` : null,
  ]
    .filter(Boolean)
    .join('; ');

  // Prose.
  const names = affected.filter((a) => a.error_count > 0).map((a) => a.name);
  const topPhrase = top ? (literalPhrase(top.pattern, top.sample_message) ?? top.pattern) : '';
  const locations = uniq(calls.map((h) => h.location).filter((l): l is string => Boolean(l)));
  let headline: string;
  let customer_impact: string;
  if (human && calls.length) {
    headline = `${calls.length} branches reporting: ${calls[0]!.short_description.replace(/\s+-\s+[^-]+$/, '')}`;
    customer_impact = `Staff at ${locations.length || calls.length} branches${locations.length ? ` (${locations.slice(0, 4).join(', ')})` : ''} report the problem; ${names.length ? `warnings rising on ${names.slice(0, 3).join(', ')}` : 'no clear errors in the logs yet'}.`;
  } else if (names.length > 3) {
    headline = `${names.slice(0, 2).join(', ')} and ${names.length - 2} more apps failing${topPhrase ? `: ${topPhrase}` : ''}`;
    customer_impact = `${names.length} applications are returning errors since ${hhmm(scopeOnset)}, including ${names.slice(0, 4).join(', ')}; customers and staff using them see failed requests.`;
  } else if (names.length) {
    headline = `${names.join(', ')} ${names.length > 1 ? 'failing' : 'errors'}${topPhrase ? `: ${topPhrase}` : ''}`;
    customer_impact = `${names.join(' and ')} ${names.length > 1 ? 'are' : 'is'} returning errors since ${hhmm(scopeOnset)}${errorRateMax ? ` (up to ${Math.round(errorRateMax * 100)}% of requests)` : ''}.`;
  } else {
    headline = `Errors reported on ${apps.join(', ') || 'unknown apps'}`;
    customer_impact = 'Impact still being assessed.';
  }

  // Grouping check (#15 tentative joins are confirmed or rejected here).
  const caseTypes = new Set(
    affected
      .filter((a) => !c.relations.find((r) => r.tla === a.tla)?.tentative)
      .flatMap((a) => (byApp.get(a.tla) ?? []).map((f) => f.error_type ?? '')),
  );
  const grouping = apps.map((tla) => {
    const a = affected.find((x) => x.tla === tla)!;
    const rel = c.relations.find((r) => r.tla === tla);
    if (human) return { tla, belongs: true, reason: 'part of what the callers describe' };
    if (a.error_count === 0 && !logSignals(c).some((s) => s.app_tla === tla))
      return { tla, belongs: false, reason: 'no errors found for it in this window' };
    if (Date.parse(a.onset) < onset - 15 * 60_000)
      return {
        tla,
        belongs: false,
        reason: `its errors started at ${hhmm(a.onset)}, well before the rest`,
      };
    if (rel?.tentative) {
      const types = (byApp.get(tla) ?? []).map((f) => f.error_type ?? '');
      const sameFamily = types.some((t) => t && caseTypes.has(t));
      const strong = rel.score >= 0.45 || sameFamily;
      return strong
        ? {
            tla,
            belongs: true,
            reason: `confirmed: ${sameFamily ? 'same error family; ' : ''}${rel.reasons.join('; ')}`,
          }
        : {
            tla,
            belongs: false,
            reason: `weak link only (${rel.reasons.join('; ')}) and a different error`,
          };
    }
    return { tla, belongs: true, reason: rel?.reasons.join('; ') || 'first signal' };
  });

  return {
    summary: headline.slice(0, 150),
    affected_apps: affected,
    onset: scopeOnset,
    signatures,
    customer_impact,
    suggested_impact: impact,
    suggested_urgency: urgency,
    severity_reason: severity_reason || 'single app, low volume',
    log_links: log_links.slice(0, 3),
    grouping,
  };
}

const TRIAGE_TOOLS = [
  'summarize_errors',
  'list_log_services',
  'get_log_histogram',
  'search_logs',
  'get_log_entry',
  'get_app',
  'search_apps',
];

const SYSTEM = `You are the triage investigator of a bank's incident-response agent. You are read-only:
you investigate with the tools and answer with JSON. Another part of the system performs every write.
Answer quickly (under 90 seconds): what is broken, for whom, since when, how bad, and whether every
app in the case really belongs to the same problem. Write plain English for bankers and engineers.
Never invent URLs: leave log_links as given in the draft unless you replace a filter, in which case
copy logs_url from the search_logs response for exactly that filter.`;

function describeCase(c: Case): string {
  const lines = [
    `Case ${c.id} (${c.kind}), onset ${c.onset_at ?? 'unknown'}.`,
    `Apps in the case: ${c.apps.join(', ') || 'none yet'}.`,
    `Why they were grouped: ${c.relations.map((r) => `${r.tla} ${r.tentative ? '(tentative) ' : ''}${r.score}: ${r.reasons.join('; ')}`).join(' | ')}`,
    `Shared upstream candidates: ${c.upstream_candidates.map((u) => `${u.tla} covers ${u.covers}/${u.of}${u.failing ? ' (failing)' : ' (no errors)'}`).join(', ')}`,
  ];
  for (const h of humans(c))
    lines.push(
      `Call ${h.incident_number} via ${h.contact_type} from ${h.caller} at ${h.location}: ${h.short_description}. ${h.description}`,
    );
  return lines.join('\n');
}

/** Runs the LLM triage phase on top of the draft. Falls back to the draft on any failure. */
export async function triage(
  deps: FlowDeps,
  c: Case,
): Promise<{ scope: ScopeReport; source: 'llm' | 'heuristic' }> {
  if (c.kind === 'human-reported' && c.apps.length === 0) {
    const found = await discoverApps(deps, c);
    if (found.apps.length) {
      c.apps = found.apps;
      c.relations = found.apps.map((tla) => ({
        tla,
        score: 1,
        reasons: found.reasons.get(tla) ?? [],
        tentative: false,
      }));
      c.upstream_candidates = deps.graph().commonUpstream(c.apps);
      deps.store.event(
        c,
        'decision',
        `Apps behind the calls: ${found.apps.map((t) => `${t} (${(found.reasons.get(t) ?? []).join('; ')})`).join(', ')}`,
      );
    }
  }
  const draft = await heuristicScope(deps, c);
  if (!deps.runner) return { scope: draft, source: 'heuristic' };
  const out = await deps.runner.run({
    name: 'triage',
    caseId: c.id,
    system: SYSTEM,
    prompt: `${describeCase(c)}\n\nA draft scope computed from the logs:\n${JSON.stringify(draft, null, 2)}\n\nCheck it with the tools and return the corrected ScopeReport JSON. Keep onset accurate to the minute.`,
    tools: TRIAGE_TOOLS,
    schema: ScopeSchema,
    maxTurns: 14,
    timeoutMs: 90_000,
  });
  if (!out.ok) {
    deps.store.event(c, 'llm', `triage phase failed (${out.error}); using the log-derived scope`);
    return { scope: draft, source: 'heuristic' };
  }
  deps.store.event(
    c,
    'llm',
    `triage phase: ${out.usage.turns} turns, ${out.usage.outputTokens} output tokens, $${out.usage.costUsd.toFixed(3)}`,
  );
  const llm = out.value;
  const draftUrls = new Set(draft.log_links.map((l) => l.logs_url));
  // Links the model changed are re-resolved through search_logs; nothing is taken on trust.
  const links: ScopeReport['log_links'] = [];
  for (const link of llm.log_links.slice(0, 3)) {
    if (draftUrls.has(link.logs_url)) links.push(link);
    else {
      try {
        const real = await logLink(deps.mcp, link.filter, c.id);
        links.push({ label: link.label, filter: link.filter, logs_url: real.logs_url });
      } catch {
        // drop it
      }
    }
  }
  return {
    scope: {
      ...llm,
      affected_apps: llm.affected_apps.length ? llm.affected_apps : draft.affected_apps,
      log_links: links.length ? links : draft.log_links,
      grouping: llm.grouping.length ? llm.grouping : draft.grouping,
    },
    source: 'llm',
  };
}
