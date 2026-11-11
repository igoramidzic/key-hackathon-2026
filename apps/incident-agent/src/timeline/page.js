/**
 * Live case timeline (#27): renders the agent's cases from `api/stream` (SSE). No build step: the
 * server inlines this file into the page. The data shapes are CaseView and friends in view.ts.
 */
const ICON = {
  check: '<svg class="icon" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>',
  spinner:
    '<svg class="icon spin" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>',
  cross: '<svg class="icon" viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  out: '<svg class="icon" viewBox="0 0 24 24"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>',
};

const KIND = {
  phase: 'Phase',
  signal: 'Signal',
  tool: 'Tools',
  decision: 'Decision',
  action: 'Action',
  message: 'Message',
  llm: 'Model',
  error: 'Error',
  note: 'Note',
};

/** id → CaseView */
const cases = new Map();
/** data-key of every <details> the viewer opened, so re-renders keep them open. */
const expanded = new Set();
const root = document.getElementById('cases');
const status = document.getElementById('status');
let connection = 'connecting';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const safeUrl = (url) => (/^https?:\/\//i.test(url ?? '') ? url : '#');
const clock = (iso) => (iso ? new Date(iso).toISOString().slice(11, 19) : '');
const words = (text) => String(text).replace(/_/g, ' ');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function span(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  return ms < 5_000 ? 'just now' : `${span(ms).split(' ')[0]} ago`;
}

const anchor = (url, inner, title) =>
  `<a href="${esc(safeUrl(url))}" target="_blank" rel="noreferrer"${title ? ` title="${esc(title)}"` : ''}>${inner}</a>`;

function chip(link) {
  const sys = link.system ? `<i class="sys sys-${esc(link.system)}"></i>` : '';
  return `<a class="chip" href="${esc(safeUrl(link.url))}" target="_blank" rel="noreferrer" title="${esc(link.title || link.url)}">${sys}<span class="chip-label">${esc(link.label)}</span>${ICON.out}</a>`;
}

const chips = (links) =>
  links.length ? `<div class="chips">${links.map(chip).join('')}</div>` : '';

const reEscape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Escapes text and links raw URLs and every record name the case knows (INC…, CHG…, MRs). */
function linker(refs) {
  const urls = new Map(refs);
  const names = [...urls.keys()].sort((a, b) => b.length - a.length).map(reEscape);
  let pattern = `(https?://[^\\s<>"']*[^\\s<>"'.,;:)\\]])`;
  if (names.length) pattern += `|(?<![\\w/.#-])(${names.join('|')})(?![\\w-])`;
  const re = new RegExp(pattern, 'g');
  return (value) => {
    const text = String(value ?? '');
    let out = '';
    let last = 0;
    for (const m of text.matchAll(re)) {
      out += esc(text.slice(last, m.index));
      out += anchor(m[1] ?? urls.get(m[2]), esc(m[0]));
      last = m.index + m[0].length;
    }
    return out + esc(text.slice(last));
  };
}

function more(key, label, items) {
  if (!items.length) return '';
  return `<details class="more" data-key="${esc(key)}"${expanded.has(key) ? ' open' : ''}><summary>${esc(label)} (${items.length})</summary><ul class="evidence">${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></details>`;
}

// ---------------------------------------------------------------------------
// One case
// ---------------------------------------------------------------------------

function head(v) {
  const apps = v.apps.map((a) => `<span class="tag">${esc(a)}</span>`).join('');
  const how = v.kind === 'human-reported' ? 'reported by a caller' : 'found by monitoring';
  const onset = v.onset_at ? `onset ${clock(v.onset_at)} · ` : '';
  return `<div class="head">
    <div class="head-row">
      <span class="badge tone-${esc(v.tone)}"><i></i>${esc(words(v.phase))}</span>${apps}
      <span class="muted">${how}</span>
      <span class="when">${onset}opened ${clock(v.opened_at)} UTC · <span data-ago="${esc(v.opened_at)}">${ago(v.opened_at)}</span></span>
    </div>
    <h2>${esc(v.title)}</h2>
    ${v.impact ? `<p class="muted">${esc(v.impact)}</p>` : ''}
  </div>`;
}

function stepper(stages) {
  const icon = { done: ICON.check, current: ICON.spinner, failed: ICON.cross };
  const steps = stages.map(
    (s) =>
      `<li class="step ${esc(s.state)} tone-${esc(s.tone)}"><b></b><span><i class="box">${icon[s.state] ?? ''}</i>${esc(s.label)}</span></li>`,
  );
  return `<ol class="steps">${steps.join('')}</ol>`;
}

function hypothesis(v, link) {
  const h = v.hypothesis;
  if (!h)
    return `<section class="panel"><h3>Current hypothesis</h3><p class="muted">${
      v.open
        ? 'None yet: the agent looks for changes promoted to the failing apps or their upstreams around the onset.'
        : 'None was formed.'
    }</p></section>`;
  const pct = Math.round(h.confidence * 100);
  const deep = h.source === 'root_cause';
  const who = [
    h.author ? `by ${esc(h.author)}` : '',
    h.promoted_at ? `promoted ${clock(h.promoted_at)} UTC` : '',
  ].filter(Boolean);
  const others = h.others.map(
    (o) =>
      `${esc(o.tla)} ${Math.round(o.confidence * 100)}%${o.change ? ` (${link(o.change)})` : ''}`,
  );
  const evidence = h.evidence.length
    ? `<ul class="evidence text">${h.evidence.map((e) => `<li>${anchor(e.url, esc(e.label), e.url)}</li>`).join('')}</ul>`
    : '';
  return `<section class="panel hyp tone-${deep ? 'accent' : 'neutral'}">
    <h3>Current hypothesis <span class="sub">${deep ? 'root cause, deep analysis' : 'top suspect, quick pass'}</span></h3>
    <div class="hyp-head"><strong>${esc(h.tla)}</strong><span class="meter"><i style="width:${pct}%"></i></span><span class="num">${pct}% confident</span></div>
    <p class="text">${link(h.text)}</p>
    ${chips(h.links)}
    ${who.length ? `<p class="muted">Change ${who.join(' · ')}</p>` : ''}
    ${evidence}
    ${more(`${v.id}:ruled`, 'Ruled out', h.ruled_out)}
    ${more(`${v.id}:unexplained`, 'Not explained', h.unexplained)}
    ${others.length ? `<p class="muted text">Also considered: ${others.join(' · ')}</p>` : ''}
  </section>`;
}

function side(v) {
  const parts = [];
  if (v.background.length) {
    const tasks = v.background.map(
      (t) =>
        `<li>${ICON.spinner}${esc(t.label)}${t.runs > 1 ? ` (run ${t.runs})` : ''}<span class="muted" data-since="${esc(t.started_at)}">${span(Date.now() - Date.parse(t.started_at))}</span></li>`,
    );
    parts.push(`<h3>Working on</h3><ul class="tasks">${tasks.join('')}</ul>`);
  }
  if (v.log_links.length) parts.push(`<h3>Logs</h3>${chips(v.log_links)}`);
  return parts.length ? `<section class="panel">${parts.join('')}</section>` : '';
}

function eventRow(e, link) {
  return `<li class="ev k-${esc(e.kind)}"><time class="num">${clock(e.at)}</time><span class="kind">${esc(KIND[e.kind] ?? e.kind)}</span><div class="body"><span class="text">${link(e.text)}</span>${chips(e.links)}</div></li>`;
}

/** A run of consecutive MCP calls, folded into one row. */
function toolRow(events, key) {
  const failed = (e) => / failed: /.test(e.text);
  const counts = new Map();
  for (const e of events) {
    const name = e.text.split(' ')[0];
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names = [...counts].map(([n, k]) => (k > 1 ? `${n} ×${k}` : n)).join(', ');
  const bad = events.filter(failed).length;
  const items = [...events]
    .reverse()
    .map(
      (e) => `<li${failed(e) ? ' class="bad"' : ''}><time>${clock(e.at)}</time>${esc(e.text)}</li>`,
    );
  return `<li class="ev k-tool"><time class="num">${clock(events.at(-1).at)}</time><span class="kind">Tools</span><div class="body"><details class="tools" data-key="${esc(key)}"${expanded.has(key) ? ' open' : ''}><summary>${plural(events.length, 'tool call')}: ${esc(names)}${bad ? ` <span class="bad">(${bad} failed)</span>` : ''}</summary><ol>${items.join('')}</ol></details></div></li>`;
}

function timeline(v, link) {
  const rows = [];
  let tools = null;
  for (const e of v.timeline) {
    if (e.kind !== 'tool') {
      tools = null;
      rows.push(e);
    } else if (tools) tools.events.push(e);
    else {
      tools = { key: `${v.id}:tools:${e.at}`, events: [e] };
      rows.push(tools);
    }
  }
  const html = rows
    .reverse()
    .map((r) => (r.events ? toolRow(r.events, r.key) : eventRow(r, link)))
    .join('');
  return `<section class="timeline"><h3>Timeline <span class="sub">${plural(v.events, 'event')}, newest first</span></h3><ol class="events">${html}</ol></section>`;
}

function body(v) {
  const link = linker(v.refs);
  const right = side(v);
  const related = v.related.map(
    (r) => `${esc(r.label)} <a href="#case-${esc(r.id)}">${esc(r.id)}</a>`,
  );
  return `<div class="card-body">
    ${stepper(v.stages)}
    ${v.failure ? `<p class="alert">Failed: ${esc(v.failure)}</p>` : ''}
    ${chips(v.links)}
    <div class="panels${right ? '' : ' single'}">${hypothesis(v, link)}${right}</div>
    ${related.length ? `<p class="muted">${related.join(' · ')}</p>` : ''}
    ${timeline(v, link)}
  </div>`;
}

function card(v) {
  const id = `case-${esc(v.id)}`;
  if (v.open) return `<article class="card" id="${id}">${head(v)}${body(v)}</article>`;
  const key = `case:${v.id}`;
  return `<details class="card closed" id="${id}" data-key="${esc(key)}"${expanded.has(key) ? ' open' : ''}><summary>${head(v)}</summary>${body(v)}</details>`;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

function render() {
  const all = [...cases.values()];
  const open = all.filter((v) => v.open).sort((a, b) => b.opened_at.localeCompare(a.opened_at));
  const closed = all
    .filter((v) => !v.open)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  if (!all.length) {
    root.innerHTML = `<div class="card empty"><strong>No cases yet</strong><p class="muted">The agent opens a case when it sees an error spike in the logs, a Moogsoft alert or a call to the service desk. It shows up here as it happens.</p></div>`;
    return;
  }
  let html = `<section class="section"><h2>Open cases <span class="sub">${open.length}</span></h2>${
    open.length
      ? open.map(card).join('')
      : '<p class="muted">Nothing open. The agent is watching the logs, alerts and the service desk.</p>'
  }</section>`;
  if (closed.length)
    html += `<section class="section"><h2>Closed <span class="sub">${closed.length}</span></h2>${closed.map(card).join('')}</section>`;
  root.innerHTML = html;
}

function setStatus(state) {
  connection = state;
  const label = { live: 'Live', connecting: 'Connecting', offline: 'Agent unreachable, retrying' };
  const tone = { live: 'positive', connecting: 'warning', offline: 'negative' };
  const open = [...cases.values()].filter((v) => v.open).length;
  status.className = `status tone-${tone[state]}`;
  status.toggleAttribute('data-live', state === 'live');
  status.innerHTML = `<i class="dot"></i>${label[state]}${state === 'live' ? ` · ${open} open` : ''}`;
}

// Updates are batched per frame. A case that stays in its section is patched in place;
// anything else redraws the list.
let full = false;
const dirty = new Set();
let queued = false;
function schedule(id) {
  if (id === undefined) full = true;
  else dirty.add(id);
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    if (full) render();
    else
      for (const id of dirty) {
        const el = document.getElementById(`case-${id}`);
        const v = cases.get(id);
        if (el && v) el.outerHTML = card(v);
      }
    full = false;
    dirty.clear();
    setStatus(connection);
  });
}

function connect() {
  const es = new EventSource('api/stream');
  es.addEventListener('open', () => setStatus('live'));
  es.addEventListener('error', () => {
    setStatus('offline');
    if (es.readyState === EventSource.CLOSED) setTimeout(connect, 3_000);
  });
  es.addEventListener('snapshot', (ev) => {
    cases.clear();
    for (const v of JSON.parse(ev.data).cases) cases.set(v.id, v);
    connection = 'live';
    schedule();
  });
  es.addEventListener('case', (ev) => {
    const v = JSON.parse(ev.data);
    const before = cases.get(v.id);
    cases.set(v.id, v);
    schedule(before && before.open === v.open ? v.id : undefined);
  });
  es.addEventListener('removed', (ev) => {
    cases.delete(JSON.parse(ev.data).id);
    schedule();
  });
}

document.addEventListener(
  'toggle',
  (ev) => {
    const key = ev.target?.dataset?.key;
    if (!key) return;
    if (ev.target.open) expanded.add(key);
    else expanded.delete(key);
  },
  true,
);

// Links to another case (merged into / split from) open it if it is closed.
window.addEventListener('hashchange', () => {
  const el = document.getElementById(decodeURIComponent(location.hash.slice(1)));
  if (el instanceof HTMLDetailsElement) el.open = true;
});

setInterval(() => {
  for (const el of document.querySelectorAll('[data-ago]')) el.textContent = ago(el.dataset.ago);
  for (const el of document.querySelectorAll('[data-since]'))
    el.textContent = span(Date.now() - Date.parse(el.dataset.since));
}, 1_000);

setStatus('connecting');
connect();
