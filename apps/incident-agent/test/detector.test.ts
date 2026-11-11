import { describe, expect, it } from 'vitest';
import type { LogSignal } from '../src/cases/types';
import { loadConfig } from '../src/config';
import { type MiniEntry, SpikeDetector } from '../src/watchers/detector';
import { readSse } from '../src/watchers/sse';
import { loadFixture, split } from './fixtures';

function detector(speed = 1) {
  const cfg = loadConfig({ AGENT_SPEED: String(speed) }).detect;
  return new SpikeDetector({ ...cfg, cooldownSec: 600 / speed });
}

function replay(d: SpikeDetector, entries: MiniEntry[]): LogSignal[] {
  return entries.flatMap((e) => d.ingest(e));
}

let seq = 0;
function entry(at: number, over: Partial<MiniEntry> = {}): MiniEntry {
  seq++;
  return {
    seq,
    insertId: `i${seq}`,
    timestamp: new Date(at).toISOString(),
    severity: 'ERROR',
    app_tla: 'PAY',
    service: 'payments-api',
    message: 'boom',
    ...over,
  };
}

describe('SpikeDetector on recorded traffic', () => {
  it('stays silent through 10+ minutes of background-only traffic', () => {
    const { entries } = loadFixture('background-16m.json.gz');
    const { learn, replay: rest } = split(entries);
    const spanMin = (Date.parse(rest.at(-1)!.timestamp) - Date.parse(rest[0]!.timestamp)) / 60_000;
    expect(spanMin).toBeGreaterThanOrEqual(10);
    const d = detector();
    d.learn(learn);
    expect(replay(d, rest)).toEqual([]);
  });

  for (const name of ['crd-pool-exhaustion-x4.json.gz', 'cif-snake-case-cascade-x4.json.gz']) {
    it(`${name}: signals within 60s of the first scenario error`, () => {
      const { meta, entries } = loadFixture(name);
      const { learn, replay: rest } = split(entries);
      const d = detector(meta.speed ?? 1);
      d.learn(learn);
      const signals = replay(d, rest).filter((s) => s.strength === 'strong');
      expect(signals.length).toBeGreaterThan(0);
      const onset = Date.parse(meta.fault_onset_at!);
      const first = signals[0]!;
      const latency = Date.parse(first.at) - onset;
      expect(latency).toBeGreaterThanOrEqual(0);
      expect(latency).toBeLessThan(60_000);
      // Nothing fired before the fault began.
      expect(signals.every((s) => Date.parse(s.at) >= onset)).toBe(true);
      expect(first.filter).toContain(`labels.app_tla="${first.app_tla}"`);
      expect(first.sample_insert_ids.length).toBeGreaterThan(0);
    });
  }

  it('the cascade lights up several apps', () => {
    const { meta, entries } = loadFixture('cif-snake-case-cascade-x4.json.gz');
    const { learn, replay: rest } = split(entries);
    const d = detector(meta.speed ?? 1);
    d.learn(learn);
    const apps = new Set(replay(d, rest).map((s) => s.app_tla));
    expect(apps.size).toBeGreaterThanOrEqual(3);
  });
});

describe('SpikeDetector rules', () => {
  const t0 = Date.parse('2026-11-11T12:00:00Z');

  it('needs the rate to hold for the sustain period', () => {
    const d = detector();
    const out: LogSignal[] = [];
    // 20 errors in 10s: over the floor, but not yet sustained for 15s.
    for (let i = 0; i < 20; i++) out.push(...d.ingest(entry(t0 + i * 500)));
    expect(out.filter((s) => s.reason === 'spike')).toHaveLength(0);
    // Over the threshold since ~5.5s (12th error); still erroring past 20.5s → fires once.
    for (let i = 0; i < 20; i++) out.push(...d.ingest(entry(t0 + 10_000 + i * 700)));
    const spikes = out.filter((s) => s.reason === 'spike');
    expect(spikes).toHaveLength(1);
    expect(spikes[0]!.filter).toBe(
      'severity>=ERROR labels.app_tla="PAY" resource.labels.container_name="payments-api"',
    );
    // Cooldown: more errors don't fire again.
    for (let i = 0; i < 20; i++) out.push(...d.ingest(entry(t0 + 25_000 + i * 500)));
    expect(out.filter((s) => s.reason === 'spike')).toHaveLength(1);
  });

  it('respects a learned baseline (k × baseline beats the floor)', () => {
    const d = detector();
    // History: this service normally logs 20 errors/min.
    const history = Array.from({ length: 100 }, (_, i) => entry(t0 - 300_000 + i * 3_000));
    d.learn(history);
    expect(d.baseline('PAY', 'payments-api')!.bad).toBeCloseTo(20, 0);
    const out: LogSignal[] = [];
    // 40/min for a minute: above the 12/min floor, below 4 × 20.
    for (let i = 0; i < 40; i++) out.push(...d.ingest(entry(t0 + i * 1_500)));
    expect(out.filter((s) => s.reason === 'spike')).toHaveLength(0);
  });

  it('flags a new error type even when the rate stays low', () => {
    const d = detector();
    d.learn([entry(t0 - 60_000, { error_type: 'java.net.SocketTimeoutException' })]);
    const out: LogSignal[] = [];
    for (let i = 0; i < 5; i++)
      out.push(...d.ingest(entry(t0 + i * 5_000, { error_type: 'IllegalStateException' })));
    const fresh = out.filter((s) => s.reason === 'new_error_type');
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.error_types).toEqual(['IllegalStateException']);
    expect(fresh[0]!.filter).toContain('jsonPayload.error.type="IllegalStateException"');
    // A known type never counts as new.
    for (let i = 0; i < 6; i++)
      out.push(
        ...d.ingest(
          entry(t0 + 30_000 + i * 5_000, { error_type: 'java.net.SocketTimeoutException' }),
        ),
      );
    expect(out.filter((s) => s.reason === 'new_error_type')).toHaveLength(1);
  });

  it('emits WARNING-only rises as weak signals', () => {
    const d = detector();
    const out: LogSignal[] = [];
    for (let i = 0; i < 40; i++)
      out.push(
        ...d.ingest(
          entry(t0 + i * 1_000, {
            severity: 'WARNING',
            app_tla: 'TLR',
            service: 'teller-workstation-api',
          }),
        ),
      );
    const weak = out.filter((s) => s.reason === 'warning_spike');
    expect(weak).toHaveLength(1);
    expect(weak[0]!.strength).toBe('weak');
    expect(weak[0]!.filter.startsWith('severity=WARNING')).toBe(true);
  });

  it('counts HTTP 5xx as bad even at WARNING severity', () => {
    const d = detector();
    const out: LogSignal[] = [];
    for (let i = 0; i < 30; i++)
      out.push(...d.ingest(entry(t0 + i * 1_000, { severity: 'WARNING', status: 503 })));
    expect(out.some((s) => s.reason === 'spike')).toBe(true);
  });

  it('tick() fires a sustained spike when the stream goes quiet', () => {
    const d = detector();
    for (let i = 0; i < 20; i++) d.ingest(entry(t0 + i * 300));
    expect(d.tick(t0 + 10_000).filter((s) => s.reason === 'spike')).toHaveLength(0);
    expect(d.tick(t0 + 20_000).filter((s) => s.reason === 'spike')).toHaveLength(1);
  });
});

describe('readSse', () => {
  it('parses events, ids, comments and split chunks', async () => {
    const text =
      'retry: 2000\n: connected\n\nevent: log\ndata: {"seq":1}\nid: 1\n\n: heartbeat\n\nevent: reset\ndata: {}\n\nevent: log\nda';
    const rest = 'ta: {"seq":2}\nid: 2\n\n';
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.enqueue(new TextEncoder().encode(rest));
        c.close();
      },
    });
    const events = [];
    for await (const ev of readSse(body)) events.push(ev);
    expect(events).toEqual([
      { event: 'log', data: '{"seq":1}', id: '1' },
      { event: 'reset', data: '{}', id: undefined },
      { event: 'log', data: '{"seq":2}', id: '2' },
    ]);
  });
});
