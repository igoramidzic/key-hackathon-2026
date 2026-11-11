import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureOnce } from '../src/actions/ensure';
import { Orchestrator, type StepFn } from '../src/cases/orchestrator';
import { CaseStore } from '../src/cases/store';
import type { Case, Phase } from '../src/cases/types';
import { silent } from '../src/log';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'agent-cases-'));
const noSleep = async () => {};

function orchestrator(store: CaseStore, steps: Partial<Record<Phase, StepFn>>, extra = {}) {
  return new Orchestrator({ store, log: silent, steps, sleep: noSleep, retryBaseMs: 1, ...extra });
}

describe('CaseStore', () => {
  it('creates, persists atomically and reloads cases', () => {
    const dir = tmp();
    const store = new CaseStore(dir);
    const c = store.create({ kind: 'monitoring', apps: ['OLB'] });
    expect(c.id).toMatch(/^case-/);
    expect(c.correlation_id).toMatch(/^agent-case:/);
    expect(c.phase).toBe('detected');
    store.event(c, 'note', 'hello');
    const files = readdirSync(path.join(dir, 'cases', c.id));
    expect(files).toEqual(['case.json']); // no temp files left behind
    const reloaded = new CaseStore(dir).load();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]!.apps).toEqual(['OLB']);
    expect(reloaded[0]!.timeline.map((e) => e.text)).toContain('hello');
  });

  it('skips corrupt case files', () => {
    const dir = tmp();
    const store = new CaseStore(dir);
    store.create({ kind: 'monitoring' });
    const bad = path.join(dir, 'cases', 'case-bad');
    mkdirSync(bad, { recursive: true });
    writeFileSync(path.join(bad, 'case.json'), '{not json');
    expect(new CaseStore(dir).load()).toHaveLength(1);
  });

  it('records phase changes and milestones, and notifies listeners', () => {
    const store = new CaseStore(tmp());
    const seen: string[] = [];
    store.subscribe((c, e) => e && seen.push(`${c.phase}:${e.kind}`));
    const c = store.create({ kind: 'monitoring' });
    store.setPhase(c, 'triaged', 'scope known');
    expect(c.milestones.triaged).toBeDefined();
    expect(c.timeline.at(-1)!.text).toBe('detected → triaged: scope known');
    expect(seen).toContain('triaged:phase');
  });
});

describe('Orchestrator transitions', () => {
  it('advances on { next } and stops at a terminal phase', async () => {
    const store = new CaseStore(tmp());
    const c = store.create({ kind: 'monitoring' });
    const o = orchestrator(store, {
      detected: async () => ({ next: 'triaged' }),
      triaged: async () => ({ next: 'resolved', why: 'done' }),
    });
    expect(await o.step(c.id)).toEqual({ done: false, waitMs: 0 });
    expect(c.phase).toBe('triaged');
    expect(await o.step(c.id)).toEqual({ done: true, waitMs: 0 });
    expect(c.phase).toBe('resolved');
  });

  it('waits on { wait } and on phases without a step', async () => {
    const store = new CaseStore(tmp());
    const c = store.create({ kind: 'monitoring' });
    const o = orchestrator(store, { detected: async () => ({ wait: 1234 }) }, { idleMs: 77 });
    expect(await o.step(c.id)).toEqual({ done: false, waitMs: 1234 });
    store.setPhase(c, 'awaiting_merge');
    expect(await o.step(c.id)).toEqual({ done: false, waitMs: 77 });
  });

  it('retries a failing step with backoff, then succeeds and resets attempts', async () => {
    const store = new CaseStore(tmp());
    const c = store.create({ kind: 'monitoring' });
    let calls = 0;
    const o = orchestrator(store, {
      detected: async () => {
        calls++;
        if (calls < 3) throw new Error('MCP down');
        return { next: 'triaged' };
      },
    });
    const first = await o.step(c.id);
    expect(first.done).toBe(false);
    expect(first.waitMs).toBeGreaterThan(0);
    expect(c.attempts.detected).toBe(1);
    await o.step(c.id);
    expect(c.attempts.detected).toBe(2);
    await o.step(c.id);
    expect(c.phase).toBe('triaged');
    expect(c.attempts.detected).toBe(0);
    expect(c.timeline.filter((e) => e.kind === 'error')).toHaveLength(2);
  });

  it('pokes do not cut a retry backoff short', async () => {
    const store = new CaseStore(tmp());
    const c = store.create({ kind: 'monitoring' });
    let calls = 0;
    const o = new Orchestrator({
      store,
      log: silent,
      retryBaseMs: 200,
      maxAttempts: 10,
      steps: {
        detected: async () => {
          calls++;
          throw new Error('bad arguments');
        },
      },
    });
    o.track(c);
    for (let i = 0; i < 20; i++) {
      o.poke(c.id);
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(calls).toBeLessThanOrEqual(2);
    await o.stop();
  });

  it('fails the case after maxAttempts and reports the reason', async () => {
    const store = new CaseStore(tmp());
    const c = store.create({ kind: 'monitoring' });
    const reported: string[] = [];
    const o = orchestrator(
      store,
      {
        detected: async () => {
          throw new Error('boom');
        },
      },
      { maxAttempts: 2, onFailed: async (_c: Case, reason: string) => void reported.push(reason) },
    );
    await o.step(c.id);
    const last = await o.step(c.id);
    expect(last.done).toBe(true);
    expect(c.phase).toBe('failed');
    expect(c.failure?.reason).toBe('detected: boom');
    expect(reported).toEqual(['detected: boom']);
  });

  it('runs a worker loop until terminal, woken by pokes', async () => {
    const store = new CaseStore(tmp());
    const c = store.create({ kind: 'monitoring' });
    let ready = false;
    const o = new Orchestrator({
      store,
      log: silent,
      steps: {
        detected: async () => (ready ? { next: 'resolved' } : { wait: 60_000 }),
      },
    });
    o.track(c);
    await new Promise((r) => setTimeout(r, 20));
    expect(c.phase).toBe('detected');
    ready = true;
    o.poke(c.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(c.phase).toBe('resolved');
    await o.stop();
  });

  it('resumes open cases from disk on start', async () => {
    const dir = tmp();
    const store = new CaseStore(dir);
    const open = store.create({ kind: 'monitoring' });
    const done = store.create({ kind: 'monitoring' });
    store.setPhase(done, 'resolved');
    store.setPhase(open, 'briefed');

    const fresh = new CaseStore(dir);
    fresh.load();
    const seen: string[] = [];
    const o = new Orchestrator({
      store: fresh,
      log: silent,
      steps: {
        briefed: async (c) => {
          seen.push(c.id);
          return { next: 'resolved' };
        },
      },
    });
    o.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([open.id]);
    await o.stop();
  });

  it('runs one background task per name and pokes the worker when it finishes', async () => {
    const store = new CaseStore(tmp());
    const c = store.create({ kind: 'monitoring' });
    const o = orchestrator(store, {});
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    expect(o.ctx.spawn(c, 'deep_rca', () => gate)).toBe(true);
    expect(o.ctx.spawn(c, 'deep_rca', () => gate)).toBe(false);
    expect(o.ctx.isRunning(c, 'deep_rca')).toBe(true);
    expect(c.background.deep_rca?.state).toBe('running');
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(o.ctx.isRunning(c, 'deep_rca')).toBe(false);
    expect(c.background.deep_rca?.state).toBe('done');

    o.ctx.spawn(c, 'fix', async () => {
      throw new Error('no diff');
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(c.background.fix).toMatchObject({ state: 'failed', error: 'no diff' });
  });

  it('archives every open case on a world reset', () => {
    const store = new CaseStore(tmp());
    const a = store.create({ kind: 'monitoring' });
    const b = store.create({ kind: 'human-reported' });
    const o = orchestrator(store, {});
    const archived = o.archiveAll('world reset (feed epoch changed)');
    expect(archived.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    expect(a.phase).toBe('abandoned');
    expect(store.open()).toHaveLength(0);
  });
});

describe('idempotency across a crash', () => {
  /** A tiny fake ServiceNow + Teams with natural-key lookups. */
  function fakeWorld() {
    const incidents: { number: string; description: string }[] = [];
    const channels: { name: string }[] = [];
    return {
      incidents,
      channels,
      createIncident: async (description: string) => {
        const inc = { number: `INC00${incidents.length + 1}`, description };
        incidents.push(inc);
        return inc;
      },
      findIncident: async (corr: string) => incidents.find((i) => i.description.includes(corr)),
      createChannel: async (name: string) => {
        if (channels.some((c) => c.name === name)) throw new Error('409 channel exists');
        channels.push({ name });
        return { name };
      },
      findChannel: async (name: string) => channels.find((c) => c.name === name),
    };
  }

  function steps(world: ReturnType<typeof fakeWorld>, crashAfterCreate: { on: boolean }) {
    const declare: StepFn = async (c, ctx) => {
      await ensureOnce({
        current: () => c.incident,
        lookup: async () => {
          const f = await world.findIncident(c.correlation_id);
          return (
            f && {
              number: f.number,
              web_url: `http://sn/${f.number}`,
              app_tla: null,
              assignment_group: null,
              priority: null,
            }
          );
        },
        create: async () => {
          const inc = await world.createIncident(`scope… [${c.correlation_id}]`);
          if (crashAfterCreate.on) throw new Error('process killed');
          return {
            number: inc.number,
            web_url: `http://sn/${inc.number}`,
            app_tla: null,
            assignment_group: null,
            priority: null,
          };
        },
        record: (v) => {
          c.incident = v;
          ctx.store.save(c);
        },
      });
      return { next: 'declared' };
    };
    const assemble: StepFn = async (c, ctx) => {
      const name = `${c.incident!.number.toLowerCase()}-errors`;
      await ensureOnce({
        current: () => c.channel,
        lookup: async () =>
          (await world.findChannel(name)) && { id: name, name, web_url: `http://t/${name}` },
        create: async () =>
          (await world.createChannel(name)) && { id: name, name, web_url: `http://t/${name}` },
        record: (v) => {
          c.channel = v;
          ctx.store.save(c);
        },
      });
      return { next: 'assembled' };
    };
    return { triaged: declare, declared: assemble };
  }

  it('continues after a crash between create and save with one incident and one channel', async () => {
    const dir = tmp();
    const world = fakeWorld();
    const crash = { on: true };

    // Run 1: the incident is created, then the agent dies before recording it.
    const store1 = new CaseStore(dir);
    const c1 = store1.create({ kind: 'monitoring' });
    store1.setPhase(c1, 'triaged');
    const o1 = orchestrator(store1, steps(world, crash), { maxAttempts: 10 });
    await o1.step(c1.id);
    expect(world.incidents).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(path.join(dir, 'cases', c1.id, 'case.json'), 'utf8')).incident,
    ).toBeNull();

    // Run 2: restart from disk.
    crash.on = false;
    const store2 = new CaseStore(dir);
    store2.load();
    const o2 = orchestrator(store2, steps(world, crash));
    await o2.step(c1.id); // declare: finds the incident by correlation id
    await o2.step(c1.id); // assemble: creates the channel
    const c2 = store2.get(c1.id)!;
    expect(c2.phase).toBe('assembled');
    expect(c2.incident?.number).toBe('INC001');

    // Run 3: a restart after the channel exists re-runs nothing.
    const store3 = new CaseStore(dir);
    store3.load();
    const c3 = store3.get(c1.id)!;
    store3.setPhase(c3, 'declared'); // pretend the phase change was lost
    c3.channel = null;
    const o3 = orchestrator(store3, steps(world, crash));
    await o3.step(c1.id);
    expect(world.incidents).toHaveLength(1);
    expect(world.channels).toHaveLength(1);
    expect(store3.get(c1.id)!.channel?.name).toBe('inc001-errors');
  });
});
