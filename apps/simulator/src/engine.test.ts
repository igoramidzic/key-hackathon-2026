import type { LogEntryInput } from '@sim/contracts/logs';
import { getApp, getWorld, Rng } from '@sim/world';
import { afterEach, describe, expect, it } from 'vitest';
import { scenarioDetail, scenarioSummary } from './api';
import { Engine } from './engine';
import { Estate } from './estate';
import { Kbr } from './kbr';
import { NoiseScheduler } from './noise';
import { fanoutTargets, logsExplorerUrl, RAMP_SEC, type RunDeps, ScenarioRun } from './run';
import {
  CIF_PROJECT,
  CONFIG_PATH,
  fakeSystems,
  seedFiles,
  testConfig,
  testScenario,
} from './test-helpers';
import { TrafficGenerator } from './traffic';
import { amount, isValidRouting, routingNumber } from './values';

const T0 = Date.parse('2026-11-09T15:00:00.000Z');

function clock(start = T0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
      return now;
    },
  };
}

function runHarness(speed = 1, scenario = testScenario()) {
  const fake = fakeSystems(seedFiles());
  const time = clock();
  const estate = new Estate();
  const emitted: LogEntryInput[] = [];
  const deploys: { tla: string; service: string; sha: string }[] = [];
  const kbr = new Kbr({
    systems: fake.systems,
    estate,
    deploy: (app, service, sha, sec, meta) => {
      deploys.push({ tla: app.tla, service, sha });
      const { before, after } = estate.deploy(app, service, sha);
      emitted.push(...estate.rolloutLines(before, after, sha, time.now(), sec, meta));
    },
    now: time.now,
    log: () => {},
    onPromoted: (p) => run.onPromoted(p),
  });
  const deps: RunDeps = {
    systems: fake.systems,
    estate,
    emit: (e) => emitted.push(...e),
    kbr,
    logsWebUrl: 'http://localhost:3001',
    now: time.now,
    log: () => {},
  };
  const run = new ScenarioRun(scenario, speed, deps);
  /** Advances wall time in 1s ticks, collecting symptom lines. */
  const step = (seconds: number) => {
    const lines: LogEntryInput[] = [];
    for (let i = 0; i < seconds; i++) lines.push(...run.tick(time.advance(1000), 1));
    return lines;
  };
  return { fake, time, estate, emitted, deploys, run, step, kbr };
}

const byTla = (lines: LogEntryInput[], tla: string) =>
  lines.filter((l) => l.labels.app_tla === tla);

describe('values', () => {
  it('generates valid ABA routing numbers', () => {
    const rng = new Rng('aba');
    for (let i = 0; i < 200; i++) expect(isValidRouting(routingNumber(rng))).toBe(true);
    expect(isValidRouting('011000015')).toBe(true);
    expect(isValidRouting('011000016')).toBe(false);
  });

  it('formats amounts', () => {
    const rng = new Rng('amt');
    for (let i = 0; i < 50; i++) expect(amount(rng)).toMatch(/^\d{1,3}(,\d{3})*\.\d{2}$/);
  });
});

describe('baseline traffic', () => {
  it('covers all 60 log-emitting apps at 15-25 lines/sec', () => {
    const gen = new TrafficGenerator(new Estate());
    expect(gen.profiles).toHaveLength(getWorld().apps.filter((a) => a.emitsLogs).length);
    gen.init(T0);
    let n = 0;
    for (let t = T0; t < T0 + 300_000; t += 1000) n += gen.generate(t, t + 1000).length;
    const perSec = n / 300;
    expect(perSec).toBeGreaterThan(15);
    expect(perSec).toBeLessThan(25);
  });

  it('is deterministic and builds full GCP entries', () => {
    const a = new TrafficGenerator(new Estate());
    const b = new TrafficGenerator(new Estate());
    a.init(T0);
    b.init(T0);
    const la = a.generate(T0, T0 + 5000);
    const lb = b.generate(T0, T0 + 5000);
    expect(la).toEqual(lb);
    const pay = la.find((e) => e.labels.app_tla === 'PAY' && e.httpRequest);
    expect(pay).toBeDefined();
    expect(pay!.logName).toBe('projects/kb-prod-pay00/logs/stdout');
    expect(pay!.resource.labels.container_name).toBe('payments-api');
    expect(pay!.resource.labels.pod_name).toMatch(/^payments-api-[a-z0-9]{10}-[a-z0-9]{5}$/);
    expect(pay!.httpRequest!.latency).toMatch(/^\d+\.\d{3}s$/);
    expect(pay!.trace).toMatch(/^projects\/kb-prod-pay00\/traces\/[0-9a-f]{32}$/);
    expect(pay!.jsonPayload!.logger).toMatch(/^c\.k\.pay\.web\./);
  });

  it('keeps 2-4 stable pods per service and rolls them on deploy', () => {
    const estate = new Estate();
    for (const app of getWorld().apps.filter((a) => a.emitsLogs)) {
      const rt = estate.get(app);
      expect(rt.pods.length).toBeGreaterThanOrEqual(2);
      expect(rt.pods.length).toBeLessThanOrEqual(4);
    }
    const cif = getApp('CIF');
    const before = estate.get(cif);
    const pods = [...before.pods];
    const version = before.version;
    estate.deploy(cif, cif.runtime.service, 'abcdef1234567890');
    expect(estate.get(cif).version).not.toBe(version);
    expect(estate.get(cif).version).toMatch(/-abcdef1$/);
    expect(estate.get(cif).pods).not.toEqual(pods);
  });
});

describe('ScenarioRun', () => {
  it('merges the bad MR at t=0 and promotes it to production through a change request', async () => {
    const h = runHarness();
    const versionBefore = h.estate.get(getApp('CIF')).version;
    await h.run.start();
    expect(h.fake.merges[0]!.project).toBe(CIF_PROJECT);
    expect(h.fake.files.get(`${CIF_PROJECT}:${CONFIG_PATH}`)).toContain('maximum-pool-size: 2\n');
    const status = h.run.status();
    expect(status.phase).toBe('pending');
    expect(status.bad_mr?.web_url).toContain('/merge_requests/1');
    expect(status.events.map((e) => e.kind).slice(0, 3)).toEqual(['merge', 'change', 'deploy']);
    expect(h.deploys[0]).toMatchObject({ tla: 'CIF', service: 'customer-profile-api' });
    const change = h.fake.changes[0]!;
    expect(status.bad_change).toEqual({ number: change.number, web_url: change.web_url });
    expect(change.state).toBe('closed');
    expect(change.merge_requests[0]!.reference).toBe(`${CIF_PROJECT}!1`);
    expect(change.deployments[0]).toMatchObject({
      project: CIF_PROJECT,
      service: 'customer-profile-api',
    });
    expect(h.fake.tags).toEqual([
      { project: CIF_PROJECT, tag: `kbr-${change.number}`, ref: status.bad_mr!.sha },
    ]);
    expect(h.fake.notes[0]!.body).toContain(change.number);
    const started = h.emitted.find((e) =>
      e.jsonPayload?.message.startsWith('Rolling update started'),
    );
    expect(started?.jsonPayload?.change_number).toBe(change.number);
    expect(h.estate.get(getApp('CIF')).version).not.toBe(versionBefore);
    const complete = h.emitted.find((e) =>
      e.jsonPayload?.message.startsWith('Rolling update complete'),
    );
    expect(complete?.jsonPayload?.message).toBe(
      `Rolling update complete: customer-profile-api revision ${status.bad_mr!.sha.slice(0, 7)}`,
    );
  });

  it('marks the run failed when the bad MR cannot be merged', async () => {
    const h = runHarness();
    h.fake.files.set(`${CIF_PROJECT}:${CONFIG_PATH}`, 'something else');
    await expect(h.run.start()).rejects.toThrow(/find not found/);
    expect(h.run.phase).toBe('failed');
    expect(h.run.status().error).toMatch(/Bad MR merge failed/);
  });

  it('starts symptoms at onset, ramps up and reaches the target rate', async () => {
    const h = runHarness();
    await h.run.start();
    // Before onset (30s) nothing but culprit-free silence.
    expect(h.step(29)).toHaveLength(0);
    expect(h.run.phase).toBe('pending');
    const first = h.step(10); // t=30..39: culprit signals only; PAY starts at 40
    expect(h.run.phase).toBe('degrading');
    expect(byTla(first, 'CIF').length).toBeGreaterThan(0);
    expect(byTla(first, 'PAY')).toHaveLength(0);
    // PAY: onset at 40, full rate (4/s) from 60s.
    h.step(21); // t=60
    const full = h.step(30);
    const payRate = byTla(full, 'PAY').length / 30;
    expect(payRate).toBeGreaterThan(3.5);
    expect(payRate).toBeLessThan(4.5);
    expect(byTla(full, 'OLB').length / 30).toBeGreaterThan(1.3);
    const err = byTla(full, 'PAY').find((l) => l.severity === 'ERROR')!;
    expect(err.jsonPayload!.message).toMatch(/^CIF lookup failed for customer C\d{8}$/);
    expect(err.httpRequest!.status).toBe(503);
    expect(err.labels.version).toBe(h.estate.get(getApp('PAY')).version);
  });

  it('ramps linearly over RAMP_SEC', async () => {
    const h = runHarness();
    await h.run.start();
    const onset = 30 + 10;
    expect(h.run.intensity({ onsetSec: onset }, onset - 1)).toBe(0);
    expect(h.run.intensity({ onsetSec: onset }, onset + RAMP_SEC / 2)).toBeCloseTo(0.5);
    expect(h.run.intensity({ onsetSec: onset }, onset + RAMP_SEC * 2)).toBe(1);
  });

  it('fans out to every log-emitting CIF consumer without an explicit impact', async () => {
    const targets = fanoutTargets(testScenario()).map((t) => t.app.tla);
    const expected = getWorld()
      .apps.filter(
        (a) => a.emitsLogs && a.upstream.includes('CIF') && !['PAY', 'OLB'].includes(a.tla),
      )
      .map((a) => a.tla);
    expect(targets.sort()).toEqual(expected.sort());
    expect(targets.length).toBeGreaterThan(10);
    const h = runHarness();
    await h.run.start();
    h.step(90);
    const lines = h.step(60);
    const reached = new Set(lines.map((l) => l.labels.app_tla));
    for (const tla of expected.slice(0, 5)) expect(reached.has(tla)).toBe(true);
    const fan = lines.find((l) => l.labels.app_tla === expected[0])!;
    expect(fan.jsonPayload!.message).toContain('customer lookup timed out');
  });

  it('divides every offset by speed', async () => {
    const h = runHarness(5);
    await h.run.start();
    expect(h.step(5)).toHaveLength(0); // 25 scenario seconds
    h.step(2); // 35 scenario seconds
    expect(h.run.phase).toBe('degrading');
    h.step(6); // 65 scenario seconds: alert (60) and herring (15) fired
    await h.run.settle();
    expect(h.fake.raised).toHaveLength(1);
    expect(h.fake.merges.map((m) => m.project)).toContain('keybank/PAY00/payments-api');
    h.step(6); // 95: helpdesk (90) and repeat alert (120) not yet
    await h.run.settle();
    expect(h.fake.incidents).toHaveLength(1);
    expect(h.fake.raised).toHaveLength(1);
    h.step(6); // 125
    await h.run.settle();
    expect(h.fake.raised).toHaveLength(2);
  });

  it('raises alerts, opens help desk incidents and lands red herrings', async () => {
    const h = runHarness();
    await h.run.start();
    h.step(16);
    await h.run.settle();
    expect(h.fake.merges).toHaveLength(2);
    expect(h.deploys.map((d) => d.tla)).toEqual(['CIF', 'PAY']);
    expect(h.fake.changes.map((c) => c.app.tla)).toEqual(['CIF', 'PAY']);
    h.step(80);
    await h.run.settle();
    const status = h.run.status();
    expect(status.alerts).toHaveLength(1);
    expect(status.alerts[0]!.web_url).toBe(`http://localhost:3001/alerts/${status.alerts[0]!.id}`);
    expect(status.helpdesk[0]!.number).toMatch(/^INC\d+$/);
    expect(status.events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['merge', 'deploy', 'red_herring', 'fault', 'alert', 'helpdesk']),
    );
    expect(status.logs_url).toBe(logsExplorerUrl('http://localhost:3001', ['CIF', 'PAY', 'OLB']));
    expect(decodeURIComponent(status.logs_url)).toContain(
      'severity>=WARNING AND (labels.app_tla="CIF" OR labels.app_tla="PAY" OR labels.app_tla="OLB")',
    );
  });

  it('waits for KBR to promote the fix, then ramps down, resolves alerts and recovers', async () => {
    const h = runHarness();
    const scenario = testScenario();
    await h.run.start();
    h.step(100);
    await h.run.settle();
    expect(await h.run.checkFix()).toBe(false);
    // An engineer merges the known fix.
    await h.fake.systems.gitlab.adminMerge({
      project: CIF_PROJECT,
      title: scenario.fix.title,
      description: scenario.fix.description,
      author: 'someone',
      merged_by: 'someone',
      source_branch: 'fix/pool',
      edits: scenario.fix.edits,
    });
    // Merged to main is only QV: still broken in production.
    expect(await h.run.checkFix()).toBe(true);
    let status = h.run.status();
    expect(status.phase).toBe('degrading');
    expect(status.fix_on_main_at).not.toBeNull();
    expect(status.fix_mr?.web_url).toContain('/merge_requests/3');
    h.step(10);
    expect(h.run.status().phase).toBe('degrading');

    // Someone raises the change request; KBR promotes it at its planned start.
    const change = await h.fake.systems.servicenow.createChange({
      short_description: 'Restore Hikari pool size',
      app_tla: 'CIF',
      merge_requests: [`${CIF_PROJECT}!3`],
      planned_start: 'now',
      type: 'emergency',
    });
    await h.kbr.poll();
    await h.run.settle();
    status = h.run.status();
    expect(status.phase).toBe('recovering');
    expect(status.fixed_at).not.toBeNull();
    expect(status.fix_change?.number).toBe(change.number);
    expect(h.deploys.at(-1)).toMatchObject({ tla: 'CIF' });

    const during = byTla(h.step(10), 'PAY').length;
    expect(during).toBeGreaterThan(0);
    expect(during).toBeLessThan(40);
    h.step(RAMP_SEC);
    await h.run.settle();
    status = h.run.status();
    expect(status.phase).toBe('recovered');
    expect(status.active).toBe(false);
    expect(h.fake.updates).toEqual([
      expect.objectContaining({
        id: status.alerts[0]!.id,
        status: 'resolved',
        note: { author: 'moogsoft', text: 'Auto-resolved: error rate back below threshold' },
      }),
    ]);
    expect(status.alerts[0]!.resolved).toBe(true);
    expect(h.step(30)).toHaveLength(0);
  });

  it('treats a promoted revert as a fix', async () => {
    const h = runHarness();
    await h.run.start();
    h.fake.applyEdits(CIF_PROJECT, [
      { path: CONFIG_PATH, find: 'maximum-pool-size: 2\n', replace: 'maximum-pool-size: 20\n' },
    ]);
    expect(await h.run.checkFix()).toBe(true);
    await h.run.onPromoted({
      change: 'CHG0030099',
      change_url: 'http://localhost:3002/change_requests/CHG0030099',
      release_id: 'KBR-1',
      project: CIF_PROJECT,
      app: getApp('CIF'),
      service: 'customer-profile-api',
      sha: 'feedface00000000000000000000000000000000',
      titles: ['Revert'],
    });
    expect(h.run.status().phase).toBe('recovering');
  });

  it('KBR refuses a change whose MR is not merged and sends it back to New', async () => {
    const h = runHarness();
    await h.run.start();
    const deploys = h.deploys.length;
    const mr = h.fake.openMr(CIF_PROJECT, 'Restore pool size');
    const change = await h.fake.systems.servicenow.createChange({
      short_description: 'Restore pool size',
      app_tla: 'CIF',
      merge_requests: [mr.references.full],
      planned_start: 'now',
    });
    await h.kbr.poll();
    expect(change.state).toBe('new');
    expect(change.release.status).toBe('failed');
    expect(h.deploys).toHaveLength(deploys);
    expect(h.run.status().phase).toBe('pending');
  });

  it('stops emitting when stopped', async () => {
    const h = runHarness();
    await h.run.start();
    h.step(80);
    h.run.stop('Stopped by operator');
    expect(h.run.phase).toBe('stopped');
    expect(h.step(30)).toHaveLength(0);
    expect(await h.run.checkFix()).toBe(false);
  });
});

describe('scenario API mapping', () => {
  it('summarizes and details a scenario', () => {
    const s = testScenario();
    const summary = scenarioSummary(s);
    expect(summary.answer_key.culprit_tla).toBe('CIF');
    expect(summary.impacted_tlas).toEqual(expect.arrayContaining(['PAY', 'OLB']));
    const detail = scenarioDetail(s);
    expect(detail.bad_mr.edits[0]!.find).toBe('maximum-pool-size: 20');
    expect(detail.fix.edits).toHaveLength(1);
    expect(detail.fanout[0]!.apps.length).toBeGreaterThan(10);
  });
});

describe('NoiseScheduler', () => {
  it('lands unrelated changes on non-hero repos and cycles background alerts', async () => {
    const fake = fakeSystems();
    const time = clock();
    const noise = new NoiseScheduler(
      {
        systems: fake.systems,
        estate: new Estate(),
        now: time.now,
        log: () => {},
      },
      { changeEverySec: [10, 10], alertEverySec: [30, 30], alertClearsAfterSec: [20, 20] },
    );
    noise.init();
    for (let i = 0; i < 120; i++) {
      time.advance(1000);
      await noise.tick();
    }
    const changes = [...fake.merges, ...fake.commits];
    expect(changes.length).toBeGreaterThanOrEqual(10);
    for (const c of changes) {
      const tla = c.project.split('/')[1]!.replace(/00$/, '');
      expect(getApp(tla).hero).toBe(false);
      expect(c.edits[0]!.path).toMatch(/^(CHANGELOG\.md|docs\/(adr|runbooks)\/.+\.md)$/);
    }
    expect(fake.raised.length).toBeGreaterThanOrEqual(3);
    for (const a of fake.raised) {
      expect(['warning', 'minor']).toContain(a.severity);
      expect(getApp(a.app_tla).hero).toBe(false);
    }
    expect(fake.updates.length).toBeGreaterThanOrEqual(2);
    expect(fake.updates.every((u) => u.status === 'resolved')).toBe(true);
  });
});

describe('Engine', () => {
  let engine: Engine | null = null;
  afterEach(() => engine?.shutdown());

  async function bootEngine(scenarios = [testScenario()]) {
    const fake = fakeSystems(seedFiles());
    const time = clock();
    engine = new Engine({
      config: testConfig(),
      systems: fake.systems,
      scenarios,
      now: time.now,
      log: () => {},
      healthCheck: async (url) => ({
        url,
        ok: true,
        latency_ms: 1,
        error: null,
        stats: url.includes('4001') ? { entries: 0 } : null,
        checked_at: new Date().toISOString(),
      }),
      backfillMinutes: 2,
      tickMs: 3_600_000,
      fixCheckMs: 3_600_000,
      healthEveryMs: 3_600_000,
    });
    await engine.boot();
    return { engine, fake, time };
  }

  it('backfills past traffic then flushes live traffic every tick', async () => {
    const { engine, fake, time } = await bootEngine();
    const backfilled = fake.ingested.length;
    expect(backfilled).toBeGreaterThan(1500);
    expect(fake.ingested.every((e) => Date.parse(e.timestamp) <= T0)).toBe(true);
    for (let i = 0; i < 10; i++) {
      time.advance(1000);
      engine.tick();
      await engine.flush();
    }
    const live = fake.ingested.slice(backfilled);
    expect(live.length).toBeGreaterThan(150);
    expect(live.every((e) => Date.parse(e.timestamp) > T0)).toBe(true);
    const status = engine.status();
    expect(status.engine.phase).toBe('running');
    expect(status.traffic.lines_per_sec).toBeGreaterThan(10);
    expect(status.systems.map((s) => s.name)).toEqual(['logs', 'servicenow', 'gitlab', 'teams']);
  });

  it('retries failed ingests from the buffer', async () => {
    const { engine, fake, time } = await bootEngine();
    const before = fake.ingested.length;
    fake.failNextIngests(1);
    time.advance(1000);
    engine.tick();
    await engine.flush();
    expect(fake.ingested.length).toBe(before);
    expect(engine.status().traffic.ingest_errors).toBe(1);
    time.advance(1000);
    engine.tick();
    await engine.flush();
    expect(fake.ingested.length - before).toBeGreaterThan(20);
  });

  it('runs one scenario at a time: 409 unless force', async () => {
    const other = testScenario({ id: 'other', title: 'Other' });
    const { engine } = await bootEngine([testScenario(), other]);
    await expect(engine.trigger('nope')).rejects.toMatchObject({ status: 404 });
    const run = await engine.trigger('test-cif-pool', { speed: 2 });
    expect(run.phase).toBe('pending');
    expect(run.speed).toBe(2);
    await expect(engine.trigger('other')).rejects.toMatchObject({ status: 409 });
    // Forcing stops the active run first; "other" re-merges the same edit, which now fails.
    await expect(engine.trigger('other', { force: true })).rejects.toMatchObject({ status: 502 });
    expect(engine.status().run).toMatchObject({ id: 'other', phase: 'failed' });
  });

  it('holds rollout lines until they are due', async () => {
    const { engine, fake, time } = await bootEngine();
    await engine.trigger('test-cif-pool');
    time.advance(1000);
    engine.tick();
    await engine.flush();
    const msgs = () => fake.ingested.map((e) => e.jsonPayload?.message ?? '');
    expect(msgs().some((m) => m.startsWith('Rolling update started: customer-profile-api'))).toBe(
      true,
    );
    expect(msgs().some((m) => m.startsWith('Rolling update complete: customer-profile-api'))).toBe(
      false,
    );
    for (let i = 0; i < 25; i++) {
      time.advance(1000);
      engine.tick();
      await engine.flush();
    }
    expect(msgs().some((m) => m.startsWith('Rolling update complete: customer-profile-api'))).toBe(
      true,
    );
  });

  it('reset stops the run, resets all four systems and backfills again', async () => {
    const { engine, fake } = await bootEngine();
    await engine.trigger('test-cif-pool');
    const res = await engine.reset();
    expect(res.ok).toBe(true);
    expect(fake.resets.sort()).toEqual(['gitlab', 'logs', 'servicenow', 'teams']);
    expect(res.backfilled_lines).toBeGreaterThan(1500);
    const status = engine.status();
    expect(status.run).toBeNull();
    expect(status.engine.phase).toBe('running');
  });

  it('stop leaves systems untouched', async () => {
    const { engine, fake } = await bootEngine();
    await engine.trigger('test-cif-pool');
    expect(engine.stop()?.phase).toBe('stopped');
    expect(fake.resets).toHaveLength(0);
    expect(engine.setTraffic({ paused: true }).paused).toBe(true);
  });
});
