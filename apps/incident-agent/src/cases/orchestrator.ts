/**
 * Moves each case through its phases. Every open case gets its own async worker that runs the
 * step function for the case's current phase:
 *
 *   step returns { next }  → change phase and run the next step right away
 *   step returns { wait }  → sleep (a poke wakes it early), then run the same step again
 *   step throws            → retry with backoff; after maxAttempts the case is `failed` and the
 *                            reason is posted (onFailed) where people can see it
 *
 * Slow work (deep RCA, fix generation, caller grouping, the chat listener) runs as named
 * background tasks next to the worker, at most one per name per case, and pokes the worker when
 * it finishes. Nothing here creates records itself; the steps do, idempotently.
 */
import type { Logger } from '../log';
import { backoffMs, errorMessage, isoNow, sleep } from '../util';
import type { CaseStore } from './store';
import { type Case, isTerminal, type Phase } from './types';

export type StepResult = { next: Phase; why?: string } | { wait: number } | undefined;

export interface StepContext {
  store: CaseStore;
  log: Logger;
  /** Starts a named background task unless one is already running for this case. */
  spawn(c: Case, name: string, fn: (signal: AbortSignal) => Promise<void>): boolean;
  isRunning(c: Case, name: string): boolean;
  cancel(c: Case, name: string): void;
  poke(caseId: string): void;
  /** Starts working a case (new or regrouped). */
  track(c: Case): void;
}

export type StepFn = (c: Case, ctx: StepContext) => Promise<StepResult>;

export interface OrchestratorOptions {
  store: CaseStore;
  log: Logger;
  steps: Partial<Record<Phase, StepFn>>;
  maxAttempts?: number;
  retryBaseMs?: number;
  /** Wait when a step returns nothing, or a phase has no step. */
  idleMs?: number;
  onFailed?: (c: Case, reason: string) => Promise<void>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

interface Waiter {
  wake: () => void;
}

export class Orchestrator {
  private readonly workers = new Map<string, Promise<void>>();
  private readonly waiters = new Map<string, Waiter>();
  private readonly pokes = new Set<string>();
  private readonly tasks = new Map<string, AbortController>();
  private readonly stopping = new AbortController();
  readonly ctx: StepContext;

  constructor(private readonly opts: OrchestratorOptions) {
    this.ctx = {
      store: opts.store,
      log: opts.log,
      spawn: (c, name, fn) => this.spawn(c, name, fn),
      isRunning: (c, name) => this.tasks.has(`${c.id}:${name}`),
      cancel: (c, name) => this.cancel(c, name),
      poke: (id) => this.poke(id),
      track: (c) => this.track(c),
    };
  }

  get stopped(): boolean {
    return this.stopping.signal.aborted;
  }

  /** Resumes every open case from the store. */
  start(): void {
    for (const c of this.opts.store.open()) this.track(c);
  }

  track(c: Case): void {
    if (this.stopped || this.workers.has(c.id) || isTerminal(c.phase)) return;
    const worker = this.work(c.id).finally(() => this.workers.delete(c.id));
    this.workers.set(c.id, worker);
  }

  poke(caseId: string): void {
    const w = this.waiters.get(caseId);
    if (w) w.wake();
    else this.pokes.add(caseId);
  }

  activeCaseIds(): string[] {
    return [...this.workers.keys()];
  }

  private async wait(caseId: string, ms: number): Promise<void> {
    if (this.pokes.delete(caseId)) return;
    const pause = this.opts.sleep ?? sleep;
    const local = new AbortController();
    const onStop = () => local.abort();
    this.stopping.signal.addEventListener('abort', onStop, { once: true });
    this.waiters.set(caseId, { wake: () => local.abort() });
    try {
      await pause(ms, local.signal);
    } finally {
      this.waiters.delete(caseId);
      this.stopping.signal.removeEventListener('abort', onStop);
    }
  }

  /** Runs one step for a case (exported for tests and the worker). Returns false when done. */
  async step(caseId: string): Promise<{ done: boolean; waitMs: number }> {
    const { store, steps } = this.opts;
    const idle = this.opts.idleMs ?? 5_000;
    const c = store.get(caseId);
    if (!c || isTerminal(c.phase)) return { done: true, waitMs: 0 };
    const phase = c.phase;
    const fn = steps[phase];
    if (!fn) return { done: false, waitMs: idle };
    let result: StepResult;
    try {
      result = await fn(c, this.ctx);
    } catch (err) {
      const max = this.opts.maxAttempts ?? 5;
      const n = (c.attempts[phase] ?? 0) + 1;
      c.attempts[phase] = n;
      const reason = errorMessage(err);
      store.event(c, 'error', `${phase} step failed (attempt ${n}/${max}): ${reason}`);
      this.opts.log.warn(`${c.id} ${phase} failed (attempt ${n}/${max}): ${reason}`);
      if (n >= max) {
        await this.fail(c, `${phase}: ${reason}`);
        return { done: true, waitMs: 0 };
      }
      return { done: false, waitMs: backoffMs(n - 1, this.opts.retryBaseMs ?? 2_000, 60_000) };
    }
    if (c.attempts[phase]) {
      c.attempts[phase] = 0;
      store.save(c);
    }
    if (result && 'next' in result) {
      store.setPhase(c, result.next, result.why);
      return { done: isTerminal(result.next), waitMs: 0 };
    }
    // The step may have moved the case itself (e.g. a regroup).
    if (c.phase !== phase) return { done: isTerminal(c.phase), waitMs: 0 };
    return { done: false, waitMs: result && 'wait' in result ? result.wait : idle };
  }

  private async work(caseId: string): Promise<void> {
    while (!this.stopped) {
      const { done, waitMs } = await this.step(caseId);
      if (done) break;
      if (waitMs > 0) await this.wait(caseId, waitMs);
    }
    if (!this.stopped) this.cancelAll(caseId);
  }

  async fail(c: Case, reason: string): Promise<void> {
    c.failure = { reason, phase: c.phase, at: isoNow() };
    this.cancelAll(c.id);
    this.opts.store.setPhase(c, 'failed', reason);
    this.opts.log.error(`${c.id} failed: ${reason}`);
    try {
      await this.opts.onFailed?.(c, reason);
    } catch (err) {
      this.opts.log.warn(`could not report failure of ${c.id}: ${errorMessage(err)}`);
    }
  }

  spawn(c: Case, name: string, fn: (signal: AbortSignal) => Promise<void>): boolean {
    const key = `${c.id}:${name}`;
    if (this.tasks.has(key) || this.stopped) return false;
    const controller = new AbortController();
    this.tasks.set(key, controller);
    const store = this.opts.store;
    const prev = c.background[name];
    c.background[name] = {
      state: 'running',
      started_at: isoNow(),
      finished_at: null,
      error: null,
      runs: (prev?.runs ?? 0) + 1,
    };
    store.event(c, 'note', `Background task started: ${name}`);
    void (async () => {
      try {
        await fn(controller.signal);
        const current = store.get(c.id) ?? c;
        current.background[name] = {
          ...current.background[name]!,
          state: controller.signal.aborted ? 'canceled' : 'done',
          finished_at: isoNow(),
        };
        store.event(current, 'note', `Background task ${current.background[name]!.state}: ${name}`);
      } catch (err) {
        const current = store.get(c.id) ?? c;
        const message = errorMessage(err);
        current.background[name] = {
          ...current.background[name]!,
          state: controller.signal.aborted ? 'canceled' : 'failed',
          finished_at: isoNow(),
          error: message,
        };
        store.event(current, 'error', `Background task ${name} failed: ${message}`);
        this.opts.log.warn(`${c.id} background ${name} failed: ${message}`);
      } finally {
        this.tasks.delete(key);
        this.poke(c.id);
      }
    })();
    return true;
  }

  cancel(c: Case, name: string): void {
    const key = `${c.id}:${name}`;
    this.tasks.get(key)?.abort();
  }

  private cancelAll(caseId: string): void {
    for (const [key, controller] of this.tasks)
      if (key.startsWith(`${caseId}:`)) controller.abort();
  }

  /** World reset: every open case is archived (abandoned) and its work stopped. */
  archiveAll(reason: string): Case[] {
    const archived: Case[] = [];
    for (const c of this.opts.store.open()) {
      this.cancelAll(c.id);
      this.opts.store.setPhase(c, 'abandoned', reason);
      this.poke(c.id);
      archived.push(c);
    }
    return archived;
  }

  async stop(): Promise<void> {
    this.stopping.abort();
    for (const controller of this.tasks.values()) controller.abort();
    await Promise.allSettled([...this.workers.values()]);
  }
}
