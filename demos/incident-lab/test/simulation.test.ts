import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Simulation, SCENARIOS, type ScenarioKey } from '../simulation.ts';
import { createServer } from '../server.ts';

function clocked() {
  let now = Date.parse('2026-11-05T17:00:00Z');
  const sim = new Simulation({ now: () => now });
  return {
    sim,
    advance: (seconds: number) => {
      now += seconds * 1000;
      return sim.tick(seconds);
    },
  };
}

test('seeded fleet contains 240 unique applications and realistic provider logs', () => {
  const { sim } = clocked();
  assert.equal(sim.apps.length, 240);
  assert.equal(new Set(sim.apps.map((a) => a.id)).size, 240);
  assert.ok(sim.apps.some((a) => a.id === 'checkout-api'));
  assert.deepEqual(new Set(sim.logs.map((l) => l.source)), new Set(['gcp', 'kibana', 'moogsoft']));
  assert.equal(sim.state().stats.healthyApps, 240);
  assert.equal(sim.incidents.length, 0);
});

test('incident progresses through detection, ownership, Teams, analysis, and recovery', () => {
  const { sim, advance } = clocked();
  sim.inject();
  assert.equal(sim.simulation.phase, 'injecting');
  assert.equal(
    sim.logs.find((l) => l.source === 'gcp' && l.severity === 'ERROR')?.traceId,
    sim.logs.find((l) => l.source === 'kibana' && l.severity === 'ERROR')?.traceId,
  );
  advance(5);
  assert.equal(sim.simulation.phase, 'detected');
  assert.equal(sim.incident.appId, 'checkout-api');
  assert.equal(sim.incident.participants.length, 0);
  advance(5);
  assert.equal(sim.simulation.phase, 'enriching');
  assert.equal(sim.incident.participants.length, 4);
  assert.equal(sim.incident.team, 'Commerce Platform');
  advance(6);
  assert.equal(sim.simulation.phase, 'collaborating');
  assert.ok(sim.messages.some((m) => m.role === 'agent' && m.links?.length === 5));
  advance(6);
  assert.equal(sim.simulation.phase, 'analyzing');
  assert.match(sim.incident.hypothesis, /concurrency/);
  sim.resolve();
  assert.equal(sim.incident.status, 'Resolved');
  assert.equal(sim.state().stats.healthyApps, 240);
  assert.ok(sim.logs.some((l) => l.metadata.recovered));
});

test('pause and speed apply to generation and incident timing; reset is repeatable', () => {
  const { sim, advance } = clocked();
  sim.inject();
  sim.control({ action: 'pause' });
  const count = sim.totalLogs;
  advance(30);
  assert.equal(sim.totalLogs, count);
  assert.equal(sim.incidentElapsed, 0);
  sim.control({ action: 'speed', speed: 4 });
  sim.control({ action: 'start' });
  advance(6);
  assert.equal(sim.simulation.phase, 'analyzing');
  sim.reset();
  assert.equal(sim.messages.length, 0);
  assert.equal(sim.incidents.length, 0);
  assert.equal(sim.simulation.speed, 1);
  assert.equal(sim.totalLogs, 144);
});

test('all scenarios support any application and retain evidence in a bounded log buffer', () => {
  for (const scenario of Object.keys(SCENARIOS) as ScenarioKey[]) {
    const { sim, advance } = clocked();
    sim.inject({ scenario, appId: 'payments-worker' });
    advance(22);
    const evidence = [...sim.incident.evidence];
    for (let i = 0; i < 200; i++) advance(1);
    assert.equal(sim.logs.length, 300);
    assert.ok(evidence.every((id) => sim.logs.some((log) => log.id === id)));
    for (const source of ['gcp', 'kibana']) {
      const link = sim.evidenceLinks().find((item) => item.href.startsWith(`/${source}?`));
      assert.ok(link);
      const logId = new URL(link.href, 'http://localhost').searchParams.get('log');
      assert.ok(logId && sim.incident.evidence.includes(logId));
      assert.ok(sim.logs.some((log) => log.id === logId && log.source === source));
    }
    assert.equal(sim.incident.appId, 'payments-worker');
    assert.equal(sim.incident.hypothesis, SCENARIOS[scenario].hypothesis);
    assert.equal(
      sim.runbooks().find((book) => book.id === sim.incident.runbookId)?.scenario,
      scenario,
    );
    assert.throws(() => sim.inject(), /current incident/);
    sim.resolve();
    sim.inject({ scenario: 'db-pool', appId: 'identity-api' });
    advance(22);
    assert.equal(sim.incidents.length, 2);
    assert.equal(sim.incident.appId, 'identity-api');
  }
});

test('chat is scoped to created rooms and returns deterministic helpful replies', () => {
  const { sim, advance } = clocked();
  assert.throws(() => sim.sendMessage('hello'), /room/);
  sim.inject();
  advance(22);
  sim.sendMessage('Who owns this app?');
  assert.match(sim.messages.at(-1)!.text, /Commerce Platform/);
  sim.sendMessage('show logs');
  assert.match(sim.messages.at(-1)!.text, /HikariPool/);
  sim.sendMessage('rollback');
  assert.match(sim.messages.at(-1)!.text, /concurrency/);
  assert.throws(() => sim.sendMessage(' '), /required/);
  assert.throws(() => sim.control({ action: 'speed', speed: 100 }), /Speed/);
  assert.throws(() => sim.inject({ scenario: 'fake' as ScenarioKey }), /Unknown scenario/);
  assert.throws(() => sim.inject({ scenario: '__proto__' as ScenarioKey }), /Unknown scenario/);
  assert.throws(() => sim.inject({ scenario: 'constructor' as ScenarioKey }), /Unknown scenario/);
  assert.throws(() => sim.control({ action: 'speed', speed: '2' as unknown as number }), /Speed/);
});

test('repeated incidents create fresh rooms and bound history without recycling incident IDs', () => {
  const { sim, advance } = clocked();
  const incidentIds = new Set<string>();
  for (let i = 0; i < 25; i++) {
    const app = sim.apps[i];
    sim.inject({ appId: app.id });
    assert.equal(sim.messages.length, 0);
    assert.throws(() => sim.sendMessage('old room?'), /room/);
    advance(22);
    assert.ok(!incidentIds.has(sim.incident.id));
    incidentIds.add(sim.incident.id);
    assert.equal(
      sim.incident.participants.find((p) => p.role.startsWith('Primary on-call'))?.name,
      app.onCall,
    );
    assert.equal(
      sim.incident.participants.find((p) => p.role === 'Service owner')?.name,
      app.owner,
    );
    assert.equal(sim.incident.participants.length, 4);
    assert.equal(new Set(sim.incident.participants.map((p) => p.name)).size, 4);
    assert.ok(sim.messages.some((m) => m.text.includes(sim.incident.id)));
    sim.sendMessage(`Unique message for incident ${i}`);
    sim.resolve();
  }
  assert.equal(sim.incidents.length, 20);
  assert.equal(sim.logs.length, 300);
  assert.ok(
    sim.incidents
      .flatMap((incident) => incident.evidence)
      .every((id) => sim.logs.some((log) => log.id === id)),
  );
  assert.equal(sim.state().stats.healthyApps, 240);
});

test('HTTP API filters logs, broadcasts state, rejects malformed input, and serves data', async (t) => {
  const { server, simulation, emit } = createServer({ ticking: false });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const get = (path: string) => fetch(base + path).then((r) => r.json());
  assert.equal((await get('/api/health')).synthetic, true);
  assert.equal((await get('/api/apps')).length, 240);
  assert.equal((await get('/api/servicenow/cmdb')).length, 240);
  assert.equal((await get('/api/confluence/runbooks')).length, 3);
  const post = (path: string, data: unknown) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  assert.equal(
    (
      await post('/api/control', {
        action: 'inject',
        appId: 'checkout-api',
        scenario: 'bad-deploy',
      })
    ).status,
    200,
  );
  const logs = await get('/api/logs?source=gcp&appId=checkout-api&severity=ERROR&limit=2');
  assert.ok(logs.length > 0);
  assert.ok(
    logs.every(
      (l: import('../simulation.ts').LogEntry) =>
        l.source === 'gcp' && l.appId === 'checkout-api' && l.severity === 'ERROR',
    ),
  );
  assert.equal((await post('/api/control', { action: 'bogus' })).status, 400);
  assert.equal(
    (await post('/api/control', { action: 'inject', scenario: '__proto__' })).status,
    400,
  );
  assert.equal((await post('/api/control', { action: 'speed', speed: '2' })).status, 400);
  assert.equal((await post('/api/control', null)).status, 400);
  assert.equal((await fetch(base + '/api/control', { method: 'POST', body: '{' })).status, 400);
  assert.equal(
    (
      await fetch(base + '/api/control', {
        method: 'POST',
        headers: { Origin: 'https://example.test' },
        body: '{}',
      })
    ).status,
    403,
  );
  const abort = new AbortController();
  const stream = await fetch(base + '/api/stream', { signal: abort.signal });
  assert.match(stream.headers.get('content-type') ?? '', /event-stream/);
  const reader = stream.body!.getReader();
  let first = '';
  while (!first.includes('\n\n')) first += new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: state/);
  assert.match(first, /"phase":"injecting"/);
  simulation.tick(22);
  emit();
  let update = '';
  while (!update.includes('"phase":"analyzing"'))
    update += new TextDecoder().decode((await reader.read()).value);
  assert.match(update, /"phase":"analyzing"/);
  abort.abort();
});

test('correlated fault metadata agrees across providers for every scenario', () => {
  for (const scenario of Object.keys(SCENARIOS) as ScenarioKey[]) {
    const { sim, advance } = clocked();
    sim.inject({ scenario });
    advance(5);
    const gcp = sim.logs.find((log) => log.source === 'gcp' && log.severity === 'ERROR')!;
    const kibana = sim.logs.find((log) => log.source === 'kibana' && log.severity === 'ERROR')!;
    assert.equal(gcp.metadata.httpStatus, kibana.metadata.httpStatus);
    assert.equal(gcp.metadata.durationMs, kibana.metadata.durationMs);
    assert.equal(gcp.metadata.httpStatus, scenario === 'bad-deploy' ? 500 : 503);
    assert.ok(sim.logs.some((log) => log.source === 'moogsoft' && log.severity === 'ERROR'));
  }
});
