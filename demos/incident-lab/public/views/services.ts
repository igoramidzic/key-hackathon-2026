import { escapeHtml as esc, formatKibana, formatStamp, formatTime, icon } from '../utils';
import type { AppState, AppRecord, LogEntry, ViewApi } from '../../types';
type ServiceView = 'gcp' | 'kibana' | 'moogsoft' | 'servicenow' | 'confluence';

const safe = (value: unknown) => esc(String(value ?? ''));
const enc = encodeURIComponent;
const currentApp = (state: AppState, query: URLSearchParams) =>
  state.apps.find(
    (app) => app.id === (query.get('app') || state.simulation.targetAppId || 'checkout-api'),
  ) || state.apps[0];
const ownerName = (app?: AppRecord) => app?.owner || 'Alex Morgan';
const appOptions = (state: AppState, selected: string, all: string) =>
  `<option value="">${all}</option>${state.apps
    .map(
      (a) =>
        `<option value="${safe(a.id)}" ${a.id === selected ? 'selected' : ''}>${safe(a.id)}</option>`,
    )
    .join('')}`;
const severityOptions = (selected: string, all: string) =>
  `<option value="">${all}</option>${['ERROR', 'WARN', 'INFO', 'DEBUG']
    .map((s) => `<option ${selected === s ? 'selected' : ''}>${s}</option>`)
    .join('')}`;

function filteredLogs(view: ServiceView, state: AppState, query: URLSearchParams) {
  const text = (query.get('q') || '').toLowerCase();
  return state.logs
    .filter(
      (l) =>
        l.source === view &&
        (!query.get('app') || l.appId === query.get('app')) &&
        (!query.get('severity') || l.severity === query.get('severity')) &&
        (!text || JSON.stringify(l).toLowerCase().includes(text)),
    )
    .slice()
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

function histogram(logs: LogEntry[], cls: string) {
  const latest = Math.max(Date.now(), ...logs.map((l) => new Date(l.timestamp).getTime()));
  const bins = Array.from({ length: 60 }, () => ({ total: 0, error: 0 }));
  logs.forEach((l) => {
    const index = 59 - Math.floor((latest - new Date(l.timestamp).getTime()) / 6000);
    if (index >= 0 && index < 60) {
      bins[index].total++;
      if (l.severity === 'ERROR') bins[index].error++;
    }
  });
  const max = Math.max(1, ...bins.map((b) => b.total));
  return `<div class="${cls}">${bins
    .map(
      (b) =>
        `<span title="${b.total} entries, ${b.error} errors" style="height:${(b.total / max) * 100}%"><i style="height:${b.total ? (b.error / b.total) * 100 : 0}%"></i></span>`,
    )
    .join('')}</div>`;
}

const empty = (text: string) => `<div class="empty-row">${text}</div>`;

/* ---------- Google Cloud · Logs Explorer ---------- */
function gcpPayload(l: LogEntry) {
  return JSON.stringify(
    {
      insertId: l.id,
      jsonPayload: { message: l.message, ...l.metadata },
      resource: {
        type: 'k8s_container',
        labels: { project_id: 'acme-production', container_name: l.appId },
      },
      timestamp: l.timestamp,
      severity: l.severity,
      trace: `projects/acme-production/traces/${l.traceId}`,
    },
    null,
    2,
  );
}
function gcp(state: AppState, query: URLSearchParams) {
  const logs = filteredLogs('gcp', state, query);
  const app = query.get('app') || '';
  const severity = query.get('severity') || '';
  const selected = query.get('log');
  const lines = [
    'resource.type="k8s_container"',
    'resource.labels.project_id="acme-production"',
    ...(app ? [`resource.labels.container_name="${app}"`] : []),
    ...(severity ? [`severity=${severity}`] : []),
    ...(query.get('q') ? [`"${query.get('q')}"`] : []),
  ];
  const sevIcon = (s: string) =>
    `<span class="g-sev g-sev-${s.toLowerCase()}" title="${s}">${s === 'ERROR' ? '!' : s === 'WARN' ? '!' : s === 'INFO' ? 'i' : '·'}</span>`;
  return `<div class="gcp">
    <header class="g-head"><span class="g-icon">${icon('menu', 20)}</span><span class="g-logo">Google Cloud</span><span class="g-project">${icon('grid', 14)} acme-production ${icon('down', 14)}</span><span class="g-search">${icon('search', 16)} Search (/) for resources, docs, products, and more</span><span class="g-icon">${icon('help', 20)}</span><span class="avatar g-avatar">AM</span></header>
    <div class="g-title"><h1>Logs Explorer</h1><span class="g-title-links"><span>Share link</span><span>Learn</span></span></div>
    <form class="g-query" data-provider-filter="gcp">
      <div class="g-query-bar"><select name="app" aria-label="Resource">${appOptions(state, app, 'All resources')}</select><select name="severity" aria-label="Severity">${severityOptions(severity, 'All severities')}</select><input name="q" aria-label="Search all fields" placeholder="Search all fields" value="${safe(query.get('q') || '')}"><span class="g-spacer"></span><span class="g-range">Last 1 hour</span>${app || severity || query.get('q') ? `<a class="g-btn-text" href="/gcp">Clear query</a>` : ''}<button class="g-btn" type="submit">Run query</button></div>
      <div class="g-editor">${lines.map((line, i) => `<div><span class="g-ln">${i + 1}</span><code>${safe(line).replace(/^([\w.]+)/, '<b>$1</b>')}</code></div>`).join('')}</div>
    </form>
    <div class="g-hist-wrap"><div class="g-hist-head">Histogram</div>${histogram(logs, 'g-hist')}</div>
    <div class="g-results-head"><strong>Query results</strong><span>${logs.length} log entries</span></div>
    <div class="g-logs"><div class="g-logs-head"><span>SEVERITY</span><span>TIMESTAMP</span><span>SUMMARY</span></div>${
      logs.length
        ? logs
            .map(
              (l) =>
                `<details class="g-row ${selected === l.id ? 'is-selected' : ''}" data-key="log-${safe(l.id)}" ${selected === l.id ? 'open' : ''}><summary><span class="g-caret">${icon('chevron', 14)}</span>${sevIcon(l.severity)}<span class="g-time">${safe(formatStamp(l.timestamp))}</span><span class="g-summary"><span class="g-chip">${safe(l.appId)}</span>${safe(l.message)}</span></summary><pre class="g-json">${safe(gcpPayload(l))}</pre></details>`,
            )
            .join('')
        : empty('No entries found. Try widening the query.')
    }</div>
  </div>`;
}

/* ---------- Kibana · Discover ---------- */
function kibanaFields(l: LogEntry): [string, unknown][] {
  const m = l.metadata || {};
  return [
    ['@timestamp', formatKibana(l.timestamp)],
    ['service.name', l.appId],
    ['log.level', l.severity.toLowerCase()],
    ['message', l.message],
    ['trace.id', l.traceId],
    ...Object.entries(m).map(([k, v]) => [`labels.${k}`, v] as [string, unknown]),
  ];
}
function kibana(state: AppState, query: URLSearchParams) {
  const logs = filteredLogs('kibana', state, query);
  const app = query.get('app') || '';
  const severity = query.get('severity') || '';
  const selected = query.get('log');
  const fields = [
    'service.name',
    'log.level',
    'message',
    'trace.id',
    'host.name',
    'http.response.status_code',
    'event.duration',
    'kubernetes.pod.name',
  ];
  const val = (v: unknown) => safe(typeof v === 'object' ? JSON.stringify(v) : v);
  return `<div class="kb">
    <header class="k-head"><span class="k-logo"><i></i>elastic</span><span class="k-find">${icon('search', 14)} Find apps, content, and more</span><span class="k-head-right">${icon('help', 18)}<span class="avatar k-avatar">AM</span></span></header>
    <div class="k-crumbs"><span class="k-menu">${icon('menu', 16)}</span><span>Discover</span><span class="k-crumb-links"><span>New</span><span>Open</span><span>Share</span><span>Inspect</span></span></div>
    <form class="k-query" data-provider-filter="kibana"><span class="k-dataview">logs-acme-production-* ${icon('down', 12)}</span><input name="q" aria-label="Search" placeholder="Filter your data using KQL syntax" value="${safe(query.get('q') || '')}"><select name="app" aria-label="service.name">${appOptions(state, app, 'service.name: any')}</select><select name="severity" aria-label="log.level">${severityOptions(severity, 'log.level: any')}</select><span class="k-date">${icon('calendar', 14)} Last 15 minutes</span><button class="k-btn" type="submit">${icon('reset', 14)} Refresh</button></form>
    ${app || severity || query.get('q') ? `<div class="k-pills">${app ? `<span class="k-pill">service.name: ${safe(app)}</span>` : ''}${severity ? `<span class="k-pill">log.level: ${safe(severity.toLowerCase())}</span>` : ''}<a href="/kibana">Clear all</a></div>` : ''}
    <div class="k-main">
      <aside class="k-fields"><div class="k-field-search">Search field names</div><div class="k-field-group">Selected fields <span>0</span></div><div class="k-field-group">Available fields <span>${fields.length}</span></div>${fields.map((f) => `<div class="k-field"><span class="k-type">${f.includes('code') || f.includes('duration') ? '#' : 't'}</span>${f}</div>`).join('')}</aside>
      <section class="k-results"><div class="k-hits"><b>${logs.length}</b> hits</div>${histogram(logs, 'k-hist')}
        <div class="k-table"><div class="k-table-head"><span></span><span>@timestamp ${icon('down', 11)}</span><span>Document</span></div>${
          logs.length
            ? logs
                .map(
                  (l) =>
                    `<details class="k-row ${selected === l.id ? 'is-selected' : ''}" data-key="log-${safe(l.id)}" ${selected === l.id ? 'open' : ''}><summary><span class="k-expand">${icon('chevron', 12)}</span><span class="k-ts">${safe(formatKibana(l.timestamp))}</span><span class="k-doc">${kibanaFields(
                      l,
                    )
                      .slice(1)
                      .map(([k, v]) => `<b>${safe(k)}</b> ${val(v)}`)
                      .join(' ')}</span></summary><table class="k-detail"><tbody>${kibanaFields(l)
                      .map(([k, v]) => `<tr><th>${safe(k)}</th><td>${val(v)}</td></tr>`)
                      .join('')}</tbody></table></details>`,
                )
                .join('')
            : empty('No results match your search criteria.')
        }</div>
      </section>
    </div>
  </div>`;
}

/* ---------- Moogsoft · Situations ---------- */
function moogsoft(state: AppState, query: URLSearchParams) {
  const logs = filteredLogs('moogsoft', state, query);
  const incidents = state.incidents.filter(
    (i) => !query.get('app') || i.appId === query.get('app'),
  );
  const current = incidents.find((i) => i.id === query.get('incident')) || incidents[0];
  const resolved = (status: string) => status.toLowerCase() === 'resolved';
  const sev = (s: string) =>
    `<span class="m-sev m-sev-${s.toLowerCase()}">${s === 'ERROR' ? 'Critical' : s === 'WARN' ? 'Major' : s === 'INFO' ? 'Clear' : 'Indeterminate'}</span>`;
  return `<div class="mg">
    <header class="m-head"><span class="m-logo">moogsoft</span><nav><a class="active" href="/moogsoft">Situations</a><a href="/moogsoft?severity=ERROR">Alerts</a><span>Services</span><span>Insights</span></nav><span class="avatar m-avatar">AM</span></header>
    <div class="m-body">
      <div class="m-bar"><h1>Open Situations</h1><span class="m-count">${incidents.filter((i) => !resolved(i.status)).length}</span></div>
      <table class="m-table"><thead><tr><th>ID</th><th>Severity</th><th>Description</th><th>Services</th><th>Status</th><th>Created</th></tr></thead><tbody>${
        incidents.length
          ? incidents
              .map(
                (i) =>
                  `<tr class="${i === current ? 'is-current' : ''}"><td><a href="/moogsoft?incident=${enc(i.id)}">${safe(i.id)}</a></td><td><span class="m-sev ${resolved(i.status) ? 'm-sev-info' : 'm-sev-error'}">${resolved(i.status) ? 'Clear' : 'Critical'}</span></td><td>${safe(i.title)}</td><td>${safe(i.appId)}</td><td>${safe(i.status)}</td><td>${safe(formatTime(i.createdAt))}</td></tr>`,
              )
              .join('')
          : `<tr><td colspan="6" class="m-none">No open situations</td></tr>`
      }</tbody></table>
      ${
        current
          ? `<section class="m-detail"><div class="m-detail-head"><h2>${safe(current.id)} · ${safe(current.title)}</h2><span class="m-status">${safe(current.status)}</span></div><p>${safe(current.summary)}</p><dl><div><dt>Service</dt><dd>${safe(current.appId)}</dd></div><div><dt>Assigned group</dt><dd>${safe(current.team)}</dd></div><div><dt>First event</dt><dd>${safe(formatTime(current.createdAt))}</dd></div><div><dt>Alerts</dt><dd>${current.evidence.length}</dd></div></dl>${current.timeline?.length ? `<h3>Activity</h3><ul class="m-activity">${current.timeline.map((t) => `<li><time>${safe(formatTime(t.time))}</time><b>${safe(t.title)}</b> ${safe(t.detail)}</li>`).join('')}</ul>` : ''}</section>`
          : ''
      }
      <div class="m-bar"><h2>Alerts</h2><span class="m-count">${logs.length}</span></div>
      <table class="m-table m-alerts"><thead><tr><th>Severity</th><th>Last event</th><th>Source</th><th>Description</th></tr></thead><tbody>${
        logs.length
          ? logs
              .slice(0, 60)
              .map(
                (l) =>
                  `<tr class="${query.get('log') === l.id ? 'is-current' : ''}"><td>${sev(l.severity)}</td><td>${safe(formatTime(l.timestamp))}</td><td>${safe(l.appId)}</td><td class="m-desc">${safe(l.message)}</td></tr>`,
              )
              .join('')
          : `<tr><td colspan="4" class="m-none">No alerts</td></tr>`
      }</tbody></table>
    </div>
  </div>`;
}

/* ---------- ServiceNow · CMDB ---------- */
const field = (label: string, value: string) =>
  `<div class="s-field"><label>${label}</label><div class="s-input">${value}</div></div>`;
function snHeader(title: string) {
  return `<header class="s-head"><span class="s-logo">servicenow</span><nav><span>All</span><span>Favorites</span><span>History</span><span>Workspaces</span></nav><span class="s-context">${safe(title)}</span><span class="s-head-right">${icon('search', 16)}${icon('help', 16)}<span class="avatar s-avatar">AM</span></span></header>`;
}
function changeRecord(state: AppState, app: AppRecord): string {
  const scenario = state.simulation.scenario;
  const details =
    scenario === 'bad-deploy'
      ? 'Deployment v2.18.0 introduced settlement currency handling for checkout requests. Legacy payloads may omit the expected currency object.'
      : scenario === 'latency'
        ? 'Deployment v2.18.0 updated the upstream client retry policy to three attempts with a 5,000 ms request deadline.'
        : 'Deployment v2.18.0 increased worker concurrency from 20 to 80; the PostgreSQL connection pool remained capped at 40 connections.';
  return `${snHeader('Change Request')}<div class="s-body"><div class="s-formbar"><a href="/servicenow?app=${enc(app.id)}" class="s-back">${icon('chevron', 14)}</a><span>Change Request</span><b>CHG0031842</b></div><div class="s-form">
    <div class="s-cols"><div>${field('Number', 'CHG0031842')}${field('Requested by', safe(ownerName(app)))}${field('Configuration item', `<a href="/servicenow?app=${enc(app.id)}">${safe(app.id)}</a>`)}${field('Risk', 'Moderate')}</div><div>${field('State', 'Implemented')}${field('Assignment group', safe(app.team))}${field('Type', 'Normal')}${field('Previous version', 'v2.17.3')}</div></div>
    ${field('Short description', `Deploy ${safe(app.id)} v2.18.0`)}
    <div class="s-field s-wide"><label>Description</label><div class="s-input s-textarea">${safe(details)}</div></div>
    <div class="s-field s-wide"><label>Backout plan</label><div class="s-input s-textarea">Restore v2.17.3 through the deployment pipeline after incident commander approval. Verify recovery using <a href="/confluence?app=${enc(app.id)}">RB-042</a>.</div></div>
  </div></div>`;
}
function ciRecord(app: AppRecord) {
  return `${snHeader('Application Service')}<div class="s-body"><div class="s-formbar"><a href="/servicenow" class="s-back">${icon('chevron', 14)}</a><span>Application Service</span><b>${safe(app.name)}</b></div><div class="s-form">
    <div class="s-cols"><div>${field('Name', safe(app.id))}${field('Number', safe(app.serviceNowId))}${field('Support group', safe(app.team))}${field('Owned by', safe(ownerName(app)))}${field('On call', safe(app.onCall))}</div><div>${field('Operational status', app.status === 'healthy' ? 'Operational' : 'Non-Operational')}${field('Business criticality', safe(app.tier))}${field('Environment', 'Production')}${field('Version', safe(app.version))}${field('Location', safe(app.region))}</div></div>
  </div>
  <div class="s-related"><div class="s-tabs"><span class="active">Change Requests (1)</span><span>Incidents</span><span>Knowledge</span></div><table class="s-list"><thead><tr><th>Number</th><th>Short description</th><th>State</th><th>Assignment group</th></tr></thead><tbody><tr><td><a href="/servicenow?app=${enc(app.id)}&record=CHG0031842">CHG0031842</a></td><td>Deploy ${safe(app.id)} v2.18.0</td><td>Implemented</td><td>${safe(app.team)}</td></tr></tbody></table><p class="s-kb">Knowledge: <a href="/confluence?app=${enc(app.id)}">RB-042 · Incident response runbook</a></p></div></div>`;
}
function servicenow(state: AppState, query: URLSearchParams) {
  const selected = query.get('app');
  const app = selected ? state.apps.find((a) => a.id === selected) : undefined;
  if (app && query.get('record') === 'CHG0031842')
    return `<div class="sn">${changeRecord(state, app)}</div>`;
  if (app) return `<div class="sn">${ciRecord(app)}</div>`;
  const q = (query.get('q') || '').toLowerCase();
  const apps = state.apps.filter((a) => !q || JSON.stringify(a).toLowerCase().includes(q));
  return `<div class="sn">${snHeader('Application Services')}<div class="s-body"><div class="s-listbar"><b>Application Services</b><form data-provider-filter="servicenow"><span>Search</span><input name="q" aria-label="Search" placeholder="Search" value="${safe(query.get('q') || '')}"></form><span class="s-pager">1 to ${Math.min(50, apps.length)} of ${apps.length}</span></div>
    <table class="s-list"><thead><tr><th>Name</th><th>Number</th><th>Support group</th><th>Owned by</th><th>Business criticality</th><th>Operational status</th></tr></thead><tbody>${
      apps.length
        ? apps
            .slice(0, 50)
            .map(
              (a) =>
                `<tr><td><a href="/servicenow?app=${enc(a.id)}">${safe(a.id)}</a></td><td>${safe(a.serviceNowId)}</td><td>${safe(a.team)}</td><td>${safe(ownerName(a))}</td><td>${safe(a.tier)}</td><td>${a.status === 'healthy' ? 'Operational' : 'Non-Operational'}</td></tr>`,
            )
            .join('')
        : `<tr><td colspan="6">No records to display</td></tr>`
    }</tbody></table></div></div>`;
}

/* ---------- Confluence · Runbook ---------- */
interface Runbook {
  label: string;
  trigger: string;
  cause: string;
  steps: string[];
  validation: string;
}
const runbooks: Record<string, Runbook> = {
  'db-pool': {
    label: 'Database connection pool exhaustion',
    trigger:
      'A rising rate of HTTP 503 responses, connection acquisition timeouts, and an exhausted database pool.',
    cause:
      'The application is exhausting its database connection pool. Correlate the start of the errors with a configuration change or deployment before choosing a mitigation.',
    steps: [
      'Compare active connections, pending requests, and pool capacity in the application logs.',
      'Inspect the most recent deployment and database pool configuration. Verify the intended connection limit with the service owner.',
      'If the regression is deployment-related, request approval from the incident commander to roll back to the last known healthy revision.',
      'After the approved mitigation, watch the error rate and connection-acquisition latency for at least five minutes.',
    ],
    validation:
      'HTTP 5xx rate returns below 1%, connection-acquisition timeouts stop, and pending pool requests drain.',
  },
  'bad-deploy': {
    label: 'Deployment regression',
    trigger:
      'Application errors begin shortly after a new revision is deployed, with elevated HTTP 500 responses.',
    cause:
      'The newest deployment may have introduced an application regression. Compare the new revision with the previous healthy revision using trace and change metadata.',
    steps: [
      'Identify the currently deployed revision and compare the error onset with its rollout time.',
      'Confirm that errors occur on the new revision and capture representative failing traces.',
      'Request incident commander approval, then roll back to the previous healthy revision using the deployment pipeline.',
      'Monitor error rate, response latency, and request volume before closing the incident.',
    ],
    validation:
      'HTTP 500 errors stop on the restored revision and synthetic health checks remain green for five minutes.',
  },
  latency: {
    label: 'Upstream dependency latency',
    trigger:
      'Request latency increases, upstream calls time out, and the service begins returning gateway errors.',
    cause:
      'A slow upstream dependency can saturate workers and propagate timeouts. Confirm the slow span and dependency before changing retry or timeout settings.',
    steps: [
      'Locate the slow upstream spans and compare dependency latency with the normal baseline.',
      'Check the upstream service status and invite its on-call engineer if the dependency is degraded.',
      'Use the approved circuit-breaker or fallback procedure after incident commander approval. Avoid increasing retries during saturation.',
      'Observe p95 latency, timeout rate, and the recovery of the upstream dependency.',
    ],
    validation:
      'p95 latency returns below 300 ms, upstream timeouts stop, and the retry queue drains.',
  },
};
function confluence(state: AppState, query: URLSearchParams) {
  const app = currentApp(state, query);
  const id = app?.id || 'checkout-api';
  const rb = runbooks[state.simulation.scenario] || runbooks['db-pool'];
  const incident = state.incidents.find((i) => i.appId === app?.id);
  const team = app?.team || 'Commerce Platform';
  const owner = ownerName(app);
  const initials = owner
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('');
  return `<div class="cf">
    <header class="c-head"><span class="c-logo"><i></i>Confluence</span><nav><span>Home</span><span>Recent ${icon('down', 12)}</span><span>Spaces ${icon('down', 12)}</span><span>Teams</span></nav><span class="c-create">+ Create</span><span class="c-search">${icon('search', 14)} Search</span><span class="avatar c-avatar">AM</span></header>
    <div class="c-layout">
      <aside class="c-side"><div class="c-space"><span class="c-space-icon">E</span><b>Engineering</b></div><div class="c-side-item">Overview</div><div class="c-side-item">Blogs</div><div class="c-side-label">Content</div><div class="c-tree">${icon('down', 12)} Operations</div><div class="c-tree c-tree-2">${icon('down', 12)} Runbooks</div><a class="c-tree c-tree-3 active" href="/confluence?app=${enc(id)}">RB-042 ${safe(rb.label)}</a><div class="c-tree c-tree-3">RB-031 Cache eviction storms</div><div class="c-tree c-tree-3">RB-017 Certificate rotation</div></aside>
      <article class="c-page">
        <div class="c-crumbs">Engineering / Operations / Runbooks</div>
        <h1>RB-042 ${safe(rb.label)}</h1>
        <div class="c-byline"><span class="avatar c-avatar">${safe(initials)}</span>Owned by ${safe(owner)} · Last updated Nov 3, 2026</div>
        <div class="c-panel">Production changes require incident commander approval.</div>
        <h2>Service ownership</h2>
        <table class="c-table"><tbody><tr><th>Application</th><td>${safe(id)}</td></tr><tr><th>Support team</th><td>${safe(team)}</td></tr><tr><th>Technical owner</th><td>${safe(owner)}</td></tr><tr><th>Escalation</th><td>Primary on-call → ${safe(team)} lead → Platform SRE</td></tr><tr><th>CMDB record</th><td><a href="/servicenow?app=${enc(id)}">${safe(app?.serviceNowId || id)}</a></td></tr></tbody></table>
        <h2>Symptoms</h2><p>${safe(rb.trigger)}</p>
        <pre class="c-code">service.name = "${safe(id)}"\nenvironment = "production"\nseverity IN ("ERROR", "WARN")</pre>
        <h2>Investigation</h2><p>${safe(incident?.hypothesis || rb.cause)}</p>
        <h2>Mitigation</h2><ol>${rb.steps.map((step) => `<li>${safe(step)}</li>`).join('')}</ol>
        <h2>Recovery criteria</h2><p>${safe(rb.validation)}</p>
      </article>
    </div>
  </div>`;
}

export function renderService(view: string, state: AppState, query = new URLSearchParams()) {
  const renderers: Record<
    string,
    ((state: AppState, query: URLSearchParams) => string) | undefined
  > = { gcp, kibana, moogsoft, servicenow, confluence };
  return (renderers[view] || gcp)(state, query);
}
export function bindService(view: string, container: HTMLElement, _state: AppState, api: ViewApi) {
  container.querySelectorAll<HTMLFormElement>('[data-provider-filter]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const params = new URLSearchParams();
      new FormData(form).forEach((value, key) => {
        if (String(value).trim()) params.set(key, String(value).trim());
      });
      api.navigate(`/${view}${params.size ? '?' + params : ''}`);
    });
    form
      .querySelectorAll('select')
      .forEach((select) => select.addEventListener('change', () => form.requestSubmit()));
  });
}
