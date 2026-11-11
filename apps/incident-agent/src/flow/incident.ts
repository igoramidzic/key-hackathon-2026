/**
 * The ServiceNow incident (#18): declared as soon as triage and the quick RCA are back, then
 * kept up to date. Deterministic code driven by the phase outputs; idempotent through the
 * correlation id written into the description.
 */

import { ensureOnce } from '../actions/ensure';
import type { Case } from '../cases/types';
import { McpToolError } from '../mcp/gateway';
import { errorMessage, hhmm } from '../util';
import { failingApps } from './rca';
import type { FlowDeps } from './steps';

export interface IncidentRecord {
  number: string;
  web_url: string;
  short_description?: string;
  state?: string;
  priority?: number;
  description?: string;
  app?: { tla: string } | null;
  assignment_group?: { id: string; name: string } | null;
  child_incidents?: { number: string }[];
  links?: { url: string }[];
}

/** The app the incident is filed against: the suspected culprit when confident, else the most affected app. */
export function incidentApp(deps: FlowDeps, c: Case): { tla: string | null; why: string } {
  const rc = c.root_cause;
  if (rc && rc.confidence >= deps.config.rcaConfidence)
    return {
      tla: rc.culprit_tla,
      why: `root cause ${rc.change_request?.number ?? ''} on ${rc.culprit_tla}`,
    };
  const top = c.suspects[0];
  if (top && top.confidence >= deps.config.rcaConfidence)
    return {
      tla: top.tla,
      why: `suspected change ${top.change_request?.number ?? ''} on ${top.tla} (${Math.round(top.confidence * 100)}%)`,
    };
  const busiest =
    c.scope?.affected_apps.find((a) => a.error_count > 0) ?? c.scope?.affected_apps[0];
  if (busiest)
    return { tla: busiest.tla, why: `most affected app (${busiest.error_count} errors)` };
  return { tla: c.apps[0] ?? null, why: 'first app in the case' };
}

export function supportGroup(deps: FlowDeps, tla: string | null): string | null {
  return tla ? (deps.graph().nodes.get(tla)?.support_group?.id ?? null) : null;
}

export function incidentDescription(deps: FlowDeps, c: Case): string {
  const s = c.scope;
  const graph = deps.graph();
  const lines: string[] = [];
  if (s) {
    lines.push(
      s.customer_impact,
      '',
      `Onset: ${s.onset} (${hhmm(s.onset)})`,
      `Severity: ${s.severity_reason}`,
      '',
    );
    lines.push(`Affected applications (${s.affected_apps.length}):`);
    for (const a of s.affected_apps.slice(0, 15))
      lines.push(
        `- ${a.tla} ${a.name}: ${a.error_count} errors since ${hhmm(a.onset)} (${a.services.join(', ') || 'no service'})`,
      );
    if (s.affected_apps.length > 15) lines.push(`- … and ${s.affected_apps.length - 15} more`);
    lines.push('', 'Log queries:');
    for (const l of s.log_links) lines.push(`- ${l.label}: ${l.logs_url}`);
    if (s.signatures.length) {
      lines.push('', 'Error signatures:');
      for (const sig of s.signatures.slice(0, 4))
        lines.push(`- ${sig.app_tla} ${sig.error_type}: ${sig.message}`);
    }
  }
  const upstream = c.upstream_candidates.find((u) => !u.failing && u.covers === u.of && u.of > 1);
  if (upstream)
    lines.push(
      '',
      `Shared upstream: every failing app depends on ${graph.label(upstream.tla)}, which logs no errors itself.`,
    );
  if (c.suspects.length) {
    lines.push('', 'Suspected changes (quick analysis, being confirmed):');
    for (const sp of c.suspects)
      lines.push(
        `- ${sp.tla} ${sp.change_request?.number ?? ''} ${sp.merge_request?.web_url ?? ''} (${Math.round(sp.confidence * 100)}%): ${sp.reason}`,
      );
  }
  const calls = c.signals.filter((x) => x.source === 'human');
  if (calls.length)
    lines.push(
      '',
      `Reported by staff: ${calls.map((h) => (h.source === 'human' ? `${h.incident_number} (${h.location ?? h.caller})` : '')).join(', ')}`,
    );
  lines.push('', `Opened by Incident Automation. Correlation: ${c.correlation_id}`);
  return lines.join('\n');
}

/** Adds an internal work note (best effort: never fails the step). */
export async function workNote(deps: FlowDeps, c: Case, text: string): Promise<void> {
  if (!c.incident) return;
  try {
    await deps.mcp.call(
      'add_incident_note',
      { number: c.incident.number, text, type: 'work_note' },
      { caseId: c.id },
    );
  } catch (err) {
    deps.log.warn(`${c.id} work note failed: ${errorMessage(err)}`);
  }
}

export async function addLinks(
  deps: FlowDeps,
  c: Case,
  links: {
    type: 'teams_channel' | 'merge_request' | 'alert' | 'log_query' | 'other';
    url: string;
    title: string;
  }[],
  work_note?: string,
): Promise<void> {
  if (!c.incident) return;
  const real = links.filter((l) => /^https?:\/\//.test(l.url));
  if (!real.length && !work_note) return;
  await deps.mcp.call(
    'update_incident',
    {
      number: c.incident.number,
      ...(real.length ? { add_links: real } : {}),
      ...(work_note ? { work_note } : {}),
    },
    { caseId: c.id },
  );
}

/** Finds an incident this case already opened (crash between create and save). */
async function findExisting(deps: FlowDeps, c: Case): Promise<IncidentRecord | null> {
  const res = await deps.mcp.call<{ items: IncidentRecord[] }>(
    'list_incidents',
    {
      query: c.correlation_id,
      opened_after: new Date(Date.parse(c.opened_at) - 3600_000).toISOString(),
      limit: 5,
    },
    { caseId: c.id },
  );
  return res.items?.[0] ?? null;
}

/** Creates (or adopts) the case's incident. */
export async function declareIncident(
  deps: FlowDeps,
  c: Case,
): Promise<'existing' | 'found' | 'created'> {
  const { tla, why } = incidentApp(deps, c);
  const group = supportGroup(deps, tla);
  const children =
    c.kind === 'human-reported'
      ? c.signals.flatMap((s) => (s.source === 'human' ? [s.incident_number] : []))
      : [];
  const { how } = await ensureOnce({
    current: () => c.incident,
    lookup: async () => {
      const found = await findExisting(deps, c);
      return found
        ? {
            number: found.number,
            web_url: found.web_url,
            app_tla: tla,
            assignment_group: group,
            priority: found.priority ?? null,
          }
        : null;
    },
    create: async () => {
      const args: Record<string, unknown> = {
        short_description: (c.scope?.summary ?? `Errors on ${c.apps.join(', ')}`).slice(0, 160),
        description: incidentDescription(deps, c),
        contact_type: 'monitoring',
        category: 'application',
        subcategory: c.apps.length > 1 ? 'Integration' : 'Software defect',
        impact: c.scope?.suggested_impact ?? 2,
        urgency: c.scope?.suggested_urgency ?? 2,
        ...(tla ? { app_tla: tla } : {}),
        ...(group ? { assignment_group: group } : {}),
        ...(children.length ? { child_incidents: children } : {}),
      };
      let inc: IncidentRecord;
      try {
        inc = await deps.mcp.call<IncidentRecord>('create_incident', args, { caseId: c.id });
      } catch (err) {
        // A child that can't be attached (already a child elsewhere) must not block declaring.
        if (!(err instanceof McpToolError) || !children.length) throw err;
        delete args.child_incidents;
        inc = await deps.mcp.call<IncidentRecord>('create_incident', args, { caseId: c.id });
      }
      return {
        number: inc.number,
        web_url: inc.web_url,
        app_tla: tla,
        assignment_group: group,
        priority: inc.priority ?? null,
      };
    },
    record: (value) => {
      c.incident = value;
      if (children.length) c.children = [...new Set([...c.children, ...children])];
      deps.store.save(c);
    },
  });
  deps.store.event(
    c,
    'action',
    `${how === 'created' ? 'Declared' : 'Adopted'} ${c.incident!.number} on ${tla ?? 'no app'} (${why}), ${group ?? 'no group'}`,
    { url: c.incident!.web_url },
  );
  return how;
}

/** Acknowledges and links every correlated Moogsoft alert to the incident. */
export async function linkAlerts(deps: FlowDeps, c: Case): Promise<number> {
  if (!c.incident) return 0;
  const onset = Date.parse(c.scope?.onset ?? c.onset_at ?? c.opened_at);
  const known = new Map(c.alerts.map((a) => [a.id, a]));
  for (const s of c.signals)
    if (s.source === 'alert' && !known.has(s.alert_id))
      known.set(s.alert_id, {
        id: s.alert_id,
        web_url: s.web_url,
        app_tla: s.app_tla,
        linked: false,
        resolved: false,
      });
  // Alerts on the affected apps raised since the onset belong here too.
  const apps = failingApps(c);
  if (apps.length) {
    try {
      const res = await deps.mcp.call<{
        items: {
          id: number;
          app_tla: string;
          web_url: string;
          first_event_time: string;
          incident_number: string | null;
        }[];
      }>(
        'list_alerts',
        {
          status: ['open', 'acknowledged'],
          since: new Date(onset - 5 * 60_000).toISOString(),
          limit: 100,
        },
        { caseId: c.id, quiet: true },
      );
      for (const a of res.items ?? []) {
        if (!apps.includes(a.app_tla) || known.has(a.id)) continue;
        if (Date.parse(a.first_event_time) < onset - 5 * 60_000) continue;
        if (a.incident_number && a.incident_number !== c.incident.number) continue;
        known.set(a.id, {
          id: a.id,
          web_url: a.web_url,
          app_tla: a.app_tla,
          linked: false,
          resolved: false,
        });
      }
    } catch (err) {
      deps.log.warn(`${c.id} list_alerts failed: ${errorMessage(err)}`);
    }
  }
  let linked = 0;
  const newLinks: { type: 'alert'; url: string; title: string }[] = [];
  for (const a of known.values()) {
    if (a.linked) continue;
    await deps.mcp.call(
      'update_alert',
      {
        id: a.id,
        incident_number: c.incident.number,
        status: 'acknowledged',
        owner: deps.config.identity,
        note: `Correlated into ${c.incident.number} by Incident Automation`,
      },
      { caseId: c.id },
    );
    a.linked = true;
    linked++;
    newLinks.push({
      type: 'alert',
      url: a.web_url,
      title: `Moogsoft alert ${a.id} (${a.app_tla})`,
    });
  }
  c.alerts = [...known.values()];
  deps.store.save(c);
  if (newLinks.length) await addLinks(deps, c, newLinks);
  if (linked) deps.store.event(c, 'action', `Linked ${linked} alert(s) to ${c.incident.number}`);
  return linked;
}

/** When the deep RCA names a different culprit, re-point the incident at it (#18). */
export async function syncIncidentApp(deps: FlowDeps, c: Case): Promise<boolean> {
  const rc = c.root_cause;
  if (!c.incident || !rc || rc.confidence < deps.config.rcaConfidence) return false;
  if (c.incident.app_tla === rc.culprit_tla) return false;
  const group = supportGroup(deps, rc.culprit_tla);
  const before = c.incident.app_tla;
  await deps.mcp.call(
    'update_incident',
    {
      number: c.incident.number,
      app_tla: rc.culprit_tla,
      ...(group ? { assignment_group: group } : {}),
      work_note:
        `Root cause analysis points at ${deps.graph().label(rc.culprit_tla)}: ${rc.change_request?.number ?? ''} ${rc.merge_request?.web_url ?? ''}. ` +
        `Re-pointing the incident from ${before ?? 'no app'} to ${rc.culprit_tla}${group ? ` and assigning ${group}` : ''}. ${rc.mechanism}`,
    },
    { caseId: c.id },
  );
  c.incident.app_tla = rc.culprit_tla;
  c.incident.assignment_group = group;
  deps.store.event(
    c,
    'action',
    `Re-pointed ${c.incident.number} from ${before ?? 'no app'} to ${rc.culprit_tla}`,
    {
      url: c.incident.web_url,
    },
  );
  return true;
}
