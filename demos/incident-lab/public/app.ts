import type { AppState, ViewApi, ControlInput } from '../types';
import { escapeHtml as e, formatTime, icon } from './utils';
import { renderService, bindService } from './views/services';
import { renderTeams, bindTeams } from './views/teams';

const app = document.querySelector<HTMLDivElement>('#app')!;
let state: AppState;
let connected = false;
let scenario = 'db-pool';
let target = 'checkout-api';
let toastTimer: ReturnType<typeof setTimeout>;
let controlQueue = Promise.resolve();
const navigation = [
  ['/', 'Control'],
  ['/gcp', 'Google Cloud'],
  ['/kibana', 'Kibana'],
  ['/moogsoft', 'Moogsoft'],
  ['/servicenow', 'ServiceNow'],
  ['/confluence', 'Confluence'],
  ['/teams', 'Teams'],
];
const scenarios = [
  ['db-pool', 'Database connection pool exhaustion'],
  ['bad-deploy', 'Faulty deployment'],
  ['latency', 'Upstream latency cascade'],
];
const stages = [
  'Alert detected',
  'Owners identified',
  'Teams chat created',
  'Mitigation proposed',
  'Resolved',
];
const phaseIndex: Record<string, number> = {
  healthy: -1,
  injecting: -1,
  detected: 0,
  enriching: 1,
  collaborating: 2,
  analyzing: 3,
  resolved: 4,
};
function navigate(path: string) {
  history.pushState({}, '', path);
  render();
  document.querySelector('#main-view')?.scrollTo(0, 0);
}
function toast(text: string) {
  const el = document.querySelector<HTMLDivElement>('#toast')!;
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}
async function request(path: string, data?: unknown): Promise<AppState> {
  const response = await fetch(
    path,
    data === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || 'The simulator could not complete this request.');
  return result as AppState;
}
async function control(input: ControlInput) {
  controlQueue = controlQueue.then(async () => {
    try {
      state = await request('/api/control', input);
      render();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Request failed');
    }
  });
  await controlQueue;
}
async function refresh() {
  try {
    state = await request('/api/state');
    render();
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Connection failed');
  }
}
const api: ViewApi = {
  navigate,
  control,
  toast,
  escape: e,
  refresh,
  sendMessage: async (text: string) => {
    state = await request('/api/messages', { text });
    render();
  },
};
function overview() {
  const sim = state.simulation;
  const incident = sim.phase === 'injecting' ? undefined : state.incidents[0];
  const isActive = !['healthy', 'resolved'].includes(sim.phase);
  const current = phaseIndex[sim.phase] ?? -1;
  const events = state.events.slice(-12).reverse();
  return `<div class="ctl"><div class="ctl-inner">
    <h1>Simulation</h1>
    <section class="ctl-card">
      <div class="ctl-form">
        <label>Scenario<select id="scenario" ${isActive ? 'disabled' : ''}>${scenarios.map(([id, name]) => `<option value="${id}" ${scenario === id ? 'selected' : ''}>${name}</option>`).join('')}</select></label>
        <label>Application<select id="target-app" ${isActive ? 'disabled' : ''}>${state.apps.map((a) => `<option value="${e(a.id)}" ${target === a.id ? 'selected' : ''}>${e(a.id)}</option>`).join('')}</select></label>
        <button class="ctl-btn primary" id="inject" ${isActive ? 'disabled' : ''}>${isActive ? 'Incident running' : 'Start incident'}</button>
      </div>
      ${
        isActive || sim.phase === 'resolved'
          ? `<ol class="ctl-steps">${stages.map((name, i) => `<li class="${current >= i ? 'done' : ''} ${current + 1 === i && isActive ? 'next' : ''}">${current >= i ? icon('check', 14) : '<i></i>'}${name}</li>`).join('')}</ol>
      <div class="ctl-status"><span>${incident ? `<b>${e(incident.id)}</b> · ${e(incident.title)} · ${e(incident.appId)}` : `Injecting fault into <b>${e(sim.targetAppId)}</b>…`}</span>${current >= 2 ? `<a href="/teams">Open in Teams ${icon('arrow', 13)}</a>` : ''}${sim.phase === 'analyzing' ? `<button class="ctl-btn" id="resolve">Simulate recovery</button>` : ''}</div>`
          : ''
      }
    </section>
    <h2>Event log</h2>
    <table class="ctl-events"><tbody>${events.map((ev) => `<tr><td class="mono">${formatTime(ev.time)}</td><td><b>${e(ev.title)}</b><span>${e(ev.detail)}</span></td></tr>`).join('') || '<tr><td>No events yet.</td></tr>'}</tbody></table>
  </div></div>`;
}
/* Live updates replace the DOM every second. Hold them while the user is
   scrolling, and while a log view is scrolled away from its newest entries. */
const LOG_VIEWS = ['gcp', 'kibana', 'moogsoft'];
let lastScrollAt = 0;
let heldSince = 0;
const currentView = () => location.pathname.replace(/\/$/, '').slice(1);
const mainScrollTop = () => document.querySelector('#main-view')?.scrollTop ?? 0;
function holdLiveUpdates() {
  if (Date.now() - lastScrollAt < 800) return true;
  return LOG_VIEWS.includes(currentView()) && mainScrollTop() > 120;
}
function showNewEntries() {
  if (!LOG_VIEWS.includes(currentView()) || mainScrollTop() <= 120) return;
  if (!heldSince) heldSince = Date.now();
  const app = new URLSearchParams(location.search).get('app');
  const count = state.logs.filter(
    (l) =>
      l.source === currentView() &&
      (!app || l.appId === app) &&
      new Date(l.timestamp).getTime() > heldSince,
  ).length;
  const pill = document.querySelector<HTMLButtonElement>('#new-entries')!;
  pill.textContent = count
    ? `↑ ${count} new ${count === 1 ? 'entry' : 'entries'}`
    : '↑ Back to live';
  pill.classList.add('show');
}
function hideNewEntries() {
  heldSince = 0;
  document.querySelector('#new-entries')?.classList.remove('show');
}
document.addEventListener(
  'scroll',
  (event) => {
    lastScrollAt = Date.now();
    if (
      event.target instanceof HTMLElement &&
      event.target.id === 'main-view' &&
      mainScrollTop() <= 120 &&
      heldSince
    )
      hideNewEntries();
  },
  { capture: true, passive: true },
);
document.querySelector('#new-entries')?.addEventListener('click', () => {
  document.querySelector('#main-view')?.scrollTo({ top: 0 });
  lastScrollAt = 0;
  render();
});
function render() {
  if (!state) return;
  hideNewEntries();
  const focus = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  const savedFocus =
    focus && (focus.id || focus.name)
      ? {
          id: focus.id,
          name: focus.name,
          start: focus.selectionStart,
          end: focus.selectionEnd,
          value: focus.value,
        }
      : null;
  const scrolls = Array.from(
    document.querySelectorAll<HTMLElement>('[data-scroll], [data-preserve-scroll]'),
  ).map((el) => ({
    key: el.id || el.className,
    top: el.scrollTop,
    atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 90,
  }));
  const details = Array.from(document.querySelectorAll<HTMLDetailsElement>('details[open]'))
    .map((el) => el.id || el.dataset.key || el.dataset.logId)
    .filter(Boolean);
  const path = location.pathname.replace(/\/$/, '') || '/';
  const view = path.slice(1);
  const query = new URLSearchParams(location.search);
  const sim = state.simulation;
  const incident = state.incidents[0];
  const status = !connected
    ? ['red', 'Reconnecting…']
    : sim.phase === 'healthy'
      ? ['green', 'All services healthy']
      : sim.phase === 'injecting'
        ? ['amber', 'Injecting fault']
        : sim.phase === 'resolved'
          ? ['green', `${incident?.id || 'Incident'} resolved`]
          : [
              'red',
              `${incident?.id || 'Incident'} · ${stages[phaseIndex[sim.phase]] || sim.phase}`,
            ];
  app.innerHTML = `<header class="lab-bar"><span class="lab-name">Incident Lab</span><nav>${navigation.map(([url, name]) => `<a href="${url}" class="${path === url ? 'active' : ''}">${name}</a>`).join('')}</nav><div class="lab-controls"><span class="lab-status"><i class="dot ${status[0]}"></i>${e(status[1])}</span><button class="lab-icon" id="toggle-stream" title="${sim.running ? 'Pause' : 'Resume'} simulation" aria-label="${sim.running ? 'Pause' : 'Resume'} simulation">${icon(sim.running ? 'pause' : 'play', 14)}</button><select id="speed" aria-label="Simulation speed">${[1, 2, 4].map((n) => `<option value="${n}" ${sim.speed === n ? 'selected' : ''}>${n}×</option>`).join('')}</select><button class="lab-icon" id="reset" title="Reset simulation" aria-label="Reset simulation">${icon('reset', 14)}</button></div></header><main id="main-view" data-preserve-scroll>${view === 'teams' ? renderTeams(state, query) : ['gcp', 'kibana', 'moogsoft', 'servicenow', 'confluence'].includes(view) ? renderService(view, state, query) : overview()}</main>`;
  bindShell();
  if (view === 'teams') bindTeams(document.querySelector('#main-view')!, state, api);
  else if (['gcp', 'kibana', 'moogsoft', 'servicenow', 'confluence'].includes(view))
    bindService(view, document.querySelector('#main-view')!, state, api);
  else bindOverview();
  if (savedFocus) {
    const el = (
      savedFocus.id
        ? document.getElementById(savedFocus.id)
        : Array.from(
            document.querySelectorAll<HTMLInputElement>('input[name],textarea[name],select[name]'),
          ).find((input) => input.name === savedFocus.name)
    ) as HTMLInputElement | null;
    if (el) {
      el.value = savedFocus.value;
      el.focus({ preventScroll: true });
      if (savedFocus.start !== null && ['text', 'search', 'textarea'].includes(el.type)) {
        try {
          el.setSelectionRange(savedFocus.start, savedFocus.end);
        } catch {
          /* Select inputs have no text selection. */
        }
      }
    }
  }
  for (const record of scrolls) {
    const el = Array.from(
      document.querySelectorAll<HTMLElement>('[data-scroll], [data-preserve-scroll]'),
    ).find((el) => (el.id || el.className) === record.key);
    if (el)
      el.scrollTop =
        el.classList.contains('t-scroll') && record.atBottom ? el.scrollHeight : record.top;
  }
  for (const key of details) {
    const detail = Array.from(document.querySelectorAll<HTMLDetailsElement>('details')).find(
      (el) => (el.id || el.dataset.key || el.dataset.logId) === key,
    );
    if (detail) detail.open = true;
  }
}
function bindShell() {
  document
    .querySelector('#toggle-stream')
    ?.addEventListener(
      'click',
      () => void control({ action: state.simulation.running ? 'pause' : 'start' }),
    );
  document
    .querySelector('#speed')
    ?.addEventListener(
      'change',
      (event) =>
        void control({ action: 'speed', speed: Number((event.target as HTMLSelectElement).value) }),
    );
  document.querySelector('#reset')?.addEventListener('click', () => {
    scenario = 'db-pool';
    target = 'checkout-api';
    void control({ action: 'reset' });
  });
}
function bindOverview() {
  document.querySelector('#scenario')?.addEventListener('change', (event) => {
    scenario = (event.target as HTMLSelectElement).value;
  });
  document
    .querySelector('#resolve')
    ?.addEventListener('click', () => void control({ action: 'resolve' }));
  document.querySelector('#target-app')?.addEventListener('change', (event) => {
    target = (event.target as HTMLSelectElement).value;
  });
  document.querySelector('#inject')?.addEventListener(
    'click',
    () =>
      void control({
        action: 'inject',
        scenario: scenario as ControlInput['scenario'],
        appId: target,
      }),
  );
}
document.addEventListener('click', (event) => {
  const anchor = (event.target as Element).closest<HTMLAnchorElement>('a[href]');
  if (
    !anchor ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    anchor.target ||
    event.button !== 0
  )
    return;
  const url = new URL(anchor.href, location.origin);
  if (url.origin === location.origin && !url.pathname.startsWith('/api/')) {
    event.preventDefault();
    navigate(url.pathname + url.search + url.hash);
  }
});
window.addEventListener('popstate', () => render());
async function connect() {
  try {
    state = await request('/api/state');
    render();
  } catch {
    app.innerHTML =
      '<div class="boot">Waiting for the simulator. Start it with <code>npm run dev</code>.</div>';
    setTimeout(() => void connect(), 2000);
    return;
  }
  const stream = new EventSource('/api/stream');
  stream.addEventListener('open', () => {
    connected = true;
    render();
  });
  stream.addEventListener('state', (event) => {
    try {
      state = JSON.parse((event as MessageEvent<string>).data) as AppState;
      connected = true;
      if (document.activeElement instanceof HTMLSelectElement) return;
      if (holdLiveUpdates()) showNewEntries();
      else render();
    } catch {
      toast('A telemetry update could not be read.');
    }
  });
  stream.addEventListener('error', () => {
    connected = false;
    render();
  });
}
void connect();
