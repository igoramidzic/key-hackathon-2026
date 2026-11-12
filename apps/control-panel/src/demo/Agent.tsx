/**
 * The agent's own moments in the demo: full-stage panels that each say one thing (what it
 * grouped, how bad it is, what caused it, how the run went), and the "meanwhile" line that shows
 * work running in the background.
 */
import { cn, SystemLogo } from '@sim/ui';
import type { AgentEvent, CaseView, NativeView } from './types';

/** Time since the first error, with its units spelled out: "56 s", "2 min 21 s", "1 h 05 min". */
export const clockOffset = (fromMs: number | null, iso: string | null | undefined) => {
  if (fromMs === null || !iso) return null;
  const s = Math.max(0, Math.round((Date.parse(iso) - fromMs) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
};

const pct = (n: number) => `${Math.round(n * 100)}%`;

// ---------------------------------------------------------------------------
// Background work
// ---------------------------------------------------------------------------

const LANE_LABEL: Record<string, string> = {
  deep_rca: 'running a deeper root-cause analysis',
  fix: 'writing the fix',
  grouping: 'matching callers to the case',
  communication: 'drafting the incident communication',
};

export interface Lane {
  name: string;
  label: string;
  startedMs: number;
}

/** Background tasks still running, read from the events shown so far. */
export function runningLanes(events: AgentEvent[]): Lane[] {
  const byName = new Map<string, Lane>();
  for (const e of events) {
    const m = /^Background task (started|done|failed|canceled): (\w+)/.exec(e.text);
    if (!m) continue;
    const name = m[2]!;
    if (m[1] === 'started')
      byName.set(name, {
        name,
        label: LANE_LABEL[name] ?? `working on ${name.replace(/_/g, ' ')}`,
        startedMs: Date.parse(e.at),
      });
    else byName.delete(name);
  }
  return [...byName.values()];
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

const CAST = [
  { logo: 'logs' as const, name: 'Logs and alerts', text: 'Where symptoms show up' },
  { logo: 'servicenow' as const, name: 'ServiceNow', text: 'Incidents, changes, owners' },
  { logo: 'gitlab' as const, name: 'GitLab', text: 'The code and its changes' },
  { logo: 'teams' as const, name: 'Teams', text: 'Where people coordinate' },
];

function Intro() {
  return (
    <div className="demo-panel is-center">
      <div className="demo-cast">
        {CAST.map((c) => (
          <div key={c.name}>
            <SystemLogo system={c.logo} className="size-8" />
            <strong>{c.name}</strong>
            <span>{c.text}</span>
          </div>
        ))}
      </div>
      <p className="demo-panel-note">
        One agent watches all four, and works through them the way a person would.
      </p>
    </div>
  );
}

function Blast({ view }: { view: CaseView | null }) {
  const apps = view?.apps ?? [];
  return (
    <div className="demo-panel is-center">
      <div className="demo-sum">
        <div>
          <b className="neg">{apps.length}</b>
          <span>applications failing</span>
        </div>
        <i aria-hidden="true">→</i>
        <div>
          <b>1</b>
          <span>case</span>
        </div>
      </div>
      <div className="demo-tiles">
        {apps.map((tla) => (
          <span key={tla}>{tla}</span>
        ))}
      </div>
    </div>
  );
}

function Triage({ view }: { view: CaseView | null }) {
  const scope = view?.records?.scope;
  if (!scope) return <Waiting />;
  const priority = Math.max(1, scope.impact + scope.urgency - 1);
  return (
    <div className="demo-panel">
      <span className="demo-badge neg">Priority {priority}</span>
      <h2>{scope.summary}</h2>
      <p className="demo-lede">{scope.customer_impact}</p>
      <dl className="demo-facts">
        <div>
          <dt>Started</dt>
          <dd>{new Date(scope.onset).toISOString().slice(11, 19)} UTC</dd>
        </div>
        <div>
          <dt>Applications affected</dt>
          <dd>{view?.apps.length ?? scope.affected.length}</dd>
        </div>
        <div>
          <dt>Hit hardest</dt>
          <dd>
            {scope.affected
              .slice(0, 3)
              .map((a) => a.name)
              .join(', ')}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function RootCause({ view }: { view: CaseView | null }) {
  const culprit = view?.records?.culprit;
  const h = view?.hypothesis;
  if (!culprit || !h) return <Waiting />;
  const ref = [culprit.change?.number, culprit.merge_request && `!${culprit.merge_request.iid}`]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="demo-panel">
      <span className="demo-badge">
        {culprit.tla} · {ref} · {pct(culprit.confidence)} confident
      </span>
      <h2>{culprit.merge_request?.title ?? `A change to ${culprit.tla}`}</h2>
      <p className="demo-lede is-clamped">{h.text}</p>
      {h.ruled_out.length > 0 && (
        <p className="demo-panel-note">
          Ruled out: {h.ruled_out.length} other change{h.ruled_out.length === 1 ? '' : 's'} that
          shipped around the same time.
        </p>
      )}
    </div>
  );
}

function Recap({ view, onsetMs }: { view: CaseView | null; onsetMs: number | null }) {
  const r = view?.records;
  if (!view || !r) return <Waiting />;
  const ms = r.milestones;
  const promoted = Object.entries(ms).find(([k]) => k.startsWith('announce:promoted'))?.[1];
  const steps: { label: string; at: string | null | undefined; human?: boolean }[] = [
    { label: 'First error noticed', at: view.opened_at },
    { label: 'Incident declared', at: ms.declared },
    {
      label: 'People briefed in one chat, call recording',
      at: ms['announce:briefing'] ?? ms.assembled,
    },
    { label: 'Incident communication drafted', at: ms.communication_new },
    { label: 'Root cause found', at: ms.root_cause },
    { label: 'Fix ready for review', at: ms.fix_proposed },
    { label: 'Fix merged', at: r.fix_mr?.merged_at ?? ms.shipping, human: true },
    { label: 'Fix in production', at: promoted ?? r.change?.deployed_at },
    { label: 'Recovery confirmed', at: ms['announce:recovered'] ?? r.verification?.healthy_since },
    {
      label: 'Resolution, problem record and all-clear written',
      at: ms.communication_restored ?? ms.problem_opened,
    },
  ].filter((s) => s.at);
  const stats = (
    [
      [String(view.apps.length), 'applications, one case'],
      [String(r.members.length), 'people brought in'],
      [String(r.children.length), 'related tickets grouped'],
      [`$${r.cost_usd.toFixed(2)}`, 'model spend'],
    ] satisfies [string, string][]
  ).filter(([n]) => n !== '0' && n !== '$0.00');
  return (
    <div className="demo-panel demo-recap">
      <ol>
        {steps.map((s) => (
          <li key={s.label} className={cn(s.human && 'is-human')}>
            <time>{clockOffset(onsetMs, s.at) ?? '0 s'}</time>
            <span>{s.label}</span>
            {s.human && <em>by a person</em>}
          </li>
        ))}
      </ol>
      <dl>
        {stats.map(([n, label]) => (
          <div key={label}>
            <dd>{n}</dd>
            <dt>{label}</dt>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Waiting() {
  return (
    <div className="demo-panel is-center">
      <p className="demo-panel-note">Waiting for the agent…</p>
    </div>
  );
}

export function NativePane({
  view: which,
  caseView,
  onsetMs,
}: {
  view: NativeView;
  caseView: CaseView | null;
  onsetMs: number | null;
}) {
  switch (which) {
    case 'intro':
      return <Intro />;
    case 'blast':
      return <Blast view={caseView} />;
    case 'triage':
      return <Triage view={caseView} />;
    case 'rootcause':
      return <RootCause view={caseView} />;
    case 'recap':
      return <Recap view={caseView} onsetMs={onsetMs} />;
  }
}
