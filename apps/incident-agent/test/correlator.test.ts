import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CaseStore } from '../src/cases/store';
import type { HumanSignal, LogSignal, Signal } from '../src/cases/types';
import { loadConfig } from '../src/config';
import { Correlator } from '../src/correlate/correlator';
import { mentionedApps, normalizeMessage } from '../src/correlate/evidence';
import { type AppNode, DependencyGraph } from '../src/correlate/graph';
import { silent } from '../src/log';
import { SpikeDetector } from '../src/watchers/detector';
import { loadFixture, split } from './fixtures';
import graphFixture from './fixtures/graph.json';

const realGraph = () =>
  DependencyGraph.fromEdges(
    graphFixture.nodes as AppNode[],
    graphFixture.edges as [string, string][],
  );

function setup(graph = realGraph(), speed = 4) {
  const store = new CaseStore(mkdtempSync(path.join(tmpdir(), 'agent-corr-')));
  const config = loadConfig({ AGENT_SPEED: String(speed) });
  const created: string[] = [];
  const changed: string[] = [];
  const correlator = new Correlator({
    store,
    graph: () => graph,
    config,
    log: silent,
    onNewCase: (c) => created.push(c.id),
    onCaseChanged: (c, ch) => ch.newApps.length && changed.push(`${c.id}:${ch.newApps.join(',')}`),
  });
  return { store, correlator, created, changed, graph };
}

function scenarioSignals(name: string): LogSignal[] {
  const { meta, entries } = loadFixture(name);
  const { learn, replay } = split(entries);
  const cfg = loadConfig({ AGENT_SPEED: String(meta.speed ?? 1) }).detect;
  const d = new SpikeDetector({ ...cfg, cooldownSec: 600 / (meta.speed ?? 1) });
  d.learn(learn);
  return replay.flatMap((e) => d.ingest(e));
}

let n = 0;
function logSignal(app: string, over: Partial<LogSignal> = {}): LogSignal {
  n++;
  return {
    source: 'logs',
    id: `s${n}`,
    at: '2026-11-11T19:14:00Z',
    app_tla: app,
    service: `${app.toLowerCase()}-svc`,
    reason: 'spike',
    strength: 'strong',
    error_types: ['SomethingFailed'],
    first_seen: '2026-11-11T19:14:00Z',
    count: 20,
    rate: 20,
    baseline: 0,
    sample_insert_ids: ['i1'],
    traces: [],
    sample_messages: ['request failed'],
    filter: `labels.app_tla="${app}"`,
    ...over,
  };
}

/** A tiny fixture graph: X and Y call U; Z is elsewhere; H is a hub everyone reaches. */
function tinyGraph() {
  const node = (tla: string, service: string | null = null): AppNode => ({
    tla,
    name: `${tla} app`,
    tier: 1,
    service,
    repos: [],
    support_group: null,
    on_call: null,
    web_url: null,
  });
  return DependencyGraph.fromEdges(
    [
      node('XAA'),
      node('YBB'),
      node('UCC', 'upstream-core-api'),
      node('ZDD'),
      node('WEE'),
      node('HUB'),
    ],
    [
      ['XAA', 'UCC'],
      ['YBB', 'UCC'],
      ['XAA', 'YBB'],
      ['ZDD', 'WEE'],
      ['UCC', 'HUB'],
      ['WEE', 'HUB'],
    ],
  );
}

describe('correlation on recorded scenarios', () => {
  it('headline cascade → exactly one case with every symptomatic app and the shared upstream', async () => {
    const { store, correlator, created } = setup();
    const signals = scenarioSignals('cif-snake-case-cascade-x4.json.gz');
    const strongApps = new Set(
      signals.filter((s) => s.strength === 'strong').map((s) => s.app_tla),
    );
    for (const s of signals) await correlator.ingest(s);
    expect(created).toHaveLength(1);
    const c = store.get(created[0]!)!;
    expect(new Set(c.apps)).toEqual(strongApps);
    expect(c.apps.length).toBeGreaterThan(10);
    // Every app's membership is explained.
    for (const tla of c.apps) {
      const rel = c.relations.find((r) => r.tla === tla);
      expect(rel?.reasons.length, tla).toBeGreaterThan(0);
    }
    // The shared upstream that every failing app depends on is a candidate, even though it logs
    // nothing: computed from the graph, never from the answer key.
    const top = c.upstream_candidates[0]!;
    expect(top.covers).toBe(c.apps.length);
    expect(top.failing).toBe(false);
  });

  it('crd-pool-exhaustion (single app) → one case with that app as its own top candidate', async () => {
    const { store, correlator, created } = setup();
    const signals = scenarioSignals('crd-pool-exhaustion-x4.json.gz');
    for (const s of signals) await correlator.ingest(s);
    expect(created).toHaveLength(1);
    const c = store.get(created[0]!)!;
    const first = signals.find((s) => s.strength === 'strong')!.app_tla;
    expect(c.apps[0]).toBe(first);
    expect(c.upstream_candidates[0]!.tla).toBe(first);
  });

  it('an unrelated app failing during the cascade gets its own case', async () => {
    const { store, correlator, created, graph } = setup();
    const signals = scenarioSignals('cif-snake-case-cascade-x4.json.gz');
    const cascade = new Set(signals.map((s) => s.app_tla));
    const mid = Math.floor(signals.length / 2);
    for (const s of signals.slice(0, mid)) await correlator.ingest(s);
    // Somewhere else in the graph: no calls to or from a failing app or the suspected upstreams.
    const near = new Set([...cascade, ...store.open()[0]!.upstream_candidates.map((u) => u.tla)]);
    const outsider = [...graph.nodes.keys()].find(
      (t) => !near.has(t) && ![...near].some((a) => graph.direct(a, t)),
    )!;
    expect(outsider).toBeDefined();
    await correlator.ingest(
      logSignal(outsider, {
        first_seen: signals[mid]!.first_seen,
        at: signals[mid]!.at,
        error_types: ['javax.net.ssl.SSLHandshakeException'],
        sample_messages: ['PKIX path building failed: unable to find valid certification path'],
      }),
    );
    for (const s of signals.slice(mid)) await correlator.ingest(s);
    expect(created).toHaveLength(2);
    const other = store.get(created[1]!)!;
    expect(other.apps).toEqual([outsider]);
    expect(store.get(created[0]!)!.apps).not.toContain(outsider);
  });
});

describe('evidence', () => {
  it('joins a sibling that names the same upstream (shared ancestor)', async () => {
    const { correlator, store } = setup(tinyGraph());
    await correlator.ingest(
      logSignal('XAA', { sample_messages: ['upstream-core-api returned an invalid profile'] }),
    );
    const d = await correlator.ingest(
      logSignal('YBB', {
        sample_messages: ['UCC lookup failed: field missing'],
        error_types: ['Other'],
      }),
    );
    expect(d.action).toBe('join');
    if (d.action === 'join') {
      expect(d.tentative).toBe(false);
      expect(d.evidence.reasons.join(' ')).toContain('name UCC');
    }
    expect(store.open()).toHaveLength(1);
  });

  it('joins a direct caller (tentatively without more evidence)', async () => {
    const { correlator } = setup(tinyGraph());
    await correlator.ingest(logSignal('YBB', { error_types: ['A'], sample_messages: ['a'] }));
    const d = await correlator.ingest(
      logSignal('XAA', { error_types: ['B'], sample_messages: ['b'] }),
    );
    expect(d.action).toBe('join');
    if (d.action === 'join') {
      expect(d.tentative).toBe(true);
      expect(d.evidence.reasons[0]).toBe('XAA calls YBB');
    }
  });

  it('joins on trace overlap', async () => {
    const graph = tinyGraph();
    const { store } = setup(graph);
    const corr = new Correlator({
      store,
      graph: () => graph,
      config: loadConfig({}),
      log: silent,
      mcp: {
        dryRun: false,
        call: async <T>() =>
          ({ items: [{ labels: { app_tla: 'WEE' } }, { labels: { app_tla: 'ZDD' } }] }) as T,
      },
      onNewCase: () => {},
      onCaseChanged: () => {},
    });
    await corr.ingest(logSignal('WEE', { error_types: ['A'], sample_messages: ['a'] }));
    // ZDD calls WEE (0.3) + timing (0.15): tentative; its traces go through WEE → join.
    const d = await corr.ingest(
      logSignal('ZDD', {
        error_types: ['B'],
        sample_messages: ['b'],
        traces: ['projects/p/traces/1'],
      }),
    );
    expect(d.action).toBe('join');
    if (d.action === 'join') {
      expect(d.tentative).toBe(false);
      expect(d.evidence.reasons.join(' ')).toContain('share traces with WEE');
    }
  });

  it('keeps same-time-but-unrelated apps apart (timing alone never joins)', async () => {
    const { correlator, store } = setup(tinyGraph());
    await correlator.ingest(logSignal('XAA'));
    const d = await correlator.ingest(
      logSignal('ZDD', { error_types: ['Other'], sample_messages: ['other'] }),
    );
    expect(d.action).toBe('new');
    expect(store.open()).toHaveLength(2);
  });

  it('a hub everyone calls is weak evidence', async () => {
    const { correlator } = setup(tinyGraph());
    await correlator.ingest(logSignal('UCC', { error_types: ['A'], sample_messages: ['a'] }));
    const d = await correlator.ingest(
      logSignal('WEE', { error_types: ['B'], sample_messages: ['b'] }),
    );
    expect(d.action).toBe('new');
  });

  it('extracts apps named in messages and normalises signatures', () => {
    const g = tinyGraph();
    expect([
      ...mentionedApps(['UCC profile failed via upstream-core-api; GET /v1 failed'], g),
    ]).toEqual(['UCC']);
    expect(normalizeMessage('Lookup failed for C123456 after 2000 ms')).toBe(
      normalizeMessage('Lookup failed for C987 after 150 ms'),
    );
  });
});

describe('settle window, late arrivals, weak, alerts, humans, cooldown', () => {
  it('opens a pending case with a settle window and lets late apps join after declaring', async () => {
    const { correlator, store, changed } = setup(tinyGraph());
    await correlator.ingest(logSignal('XAA', { sample_messages: ['upstream-core-api broke'] }));
    const c = store.open()[0]!;
    expect(c.phase).toBe('detected');
    expect(Date.parse(c.settle_until!)).toBeGreaterThan(Date.now());
    store.setPhase(c, 'briefed');
    await correlator.ingest(logSignal('YBB', { sample_messages: ['upstream-core-api broke'] }));
    expect(store.open()).toHaveLength(1);
    expect(c.apps).toEqual(['XAA', 'YBB']);
    expect(changed).toEqual([`${c.id}:YBB`]);
  });

  it('weak signals and alerts never open a case, but attach to a related one', async () => {
    const { correlator, store } = setup(tinyGraph());
    // Buffers keep the last 15 minutes of wall-clock time, so use current timestamps.
    const now = new Date().toISOString();
    const weak = await correlator.ingest(
      logSignal('XAA', { strength: 'weak', reason: 'warning_spike', at: now, first_seen: now }),
    );
    expect(weak.action).toBe('buffer');
    const alert: Signal = {
      source: 'alert',
      id: 'a1',
      at: now,
      alert_id: 1,
      app_tla: 'YBB',
      service: 'y',
      severity: 'critical',
      description: '5xx',
      web_url: 'http://logs/alerts/1',
    };
    expect((await correlator.ingest(alert)).action).toBe('buffer');
    expect(store.open()).toHaveLength(0);
    await correlator.ingest(logSignal('XAA'));
    const c = store.open()[0]!;
    // The buffered weak signal on a related app is adopted; the alert waits for YBB itself.
    expect(c.signals.some((s) => s.source === 'logs' && s.strength === 'weak')).toBe(true);
    expect(c.signals.map((s) => s.id)).not.toContain('a1');
    await correlator.ingest(logSignal('YBB', { sample_messages: ['upstream-core-api broke'] }));
    expect(c.apps).toContain('YBB');
    expect(c.signals.map((s) => s.id)).toContain('a1');
  });

  const call = (num: string, at: string, over: Partial<HumanSignal> = {}): HumanSignal => ({
    source: 'human',
    id: `human-${num}`,
    at,
    incident_number: num,
    short_description: 'Teller drawers out of balance',
    description: '',
    caller: 'mlopez',
    location: 'Cleveland',
    contact_type: 'phone',
    app_tla: null,
    impact: 2,
    urgency: 2,
    web_url: `http://sn/${num}`,
    ...over,
  });

  it('opens a human-reported case on the second call, not the first', async () => {
    const { correlator, store, created } = setup(tinyGraph());
    await correlator.ingest(
      logSignal('WEE', { strength: 'weak', reason: 'warning_spike', at: new Date().toISOString() }),
    );
    const now = Date.now();
    expect((await correlator.ingest(call('INC1', new Date(now).toISOString()))).action).toBe(
      'buffer',
    );
    const d = await correlator.ingest(call('INC2', new Date(now + 60_000).toISOString()));
    expect(d.action).toBe('new');
    const c = store.get(created[0]!)!;
    expect(c.kind).toBe('human-reported');
    expect(c.signals.filter((s) => s.source === 'human')).toHaveLength(2);
    expect(c.signals.some((s) => s.source === 'logs')).toBe(true); // supporting warnings
  });

  it('an urgent call opens a case on its own; calls during an open case attach to it', async () => {
    const { correlator, store } = setup(tinyGraph());
    expect(
      (await correlator.ingest(call('INC9', new Date().toISOString(), { impact: 1, urgency: 1 })))
        .action,
    ).toBe('new');
    const d = await correlator.ingest(call('INC10', new Date().toISOString()));
    expect(d.action).toBe('attach');
    expect(store.open()).toHaveLength(1);
  });

  it('a resolved case suppresses new cases for its apps during the cooldown', async () => {
    const { correlator, store } = setup(tinyGraph());
    await correlator.ingest(logSignal('ZDD'));
    store.setPhase(store.open()[0]!, 'resolved');
    const d = await correlator.ingest(logSignal('ZDD'));
    expect(d.action).toBe('suppress');
  });
});
