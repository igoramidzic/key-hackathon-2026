/**
 * Follows the live log stream: `GET {logs}/api/logs/stream?severity=WARNING` (SSE, id = seq).
 * Reconnects with `Last-Event-ID` so nothing is missed, and falls back to the long-poll tail
 * (`/api/logs/tail?after_seq=&wait_seconds=`) when SSE keeps failing (some proxies buffer it).
 * A `reset` event (or the seq going backwards) means the world was reset.
 */
import type { LogEntry, LogSearchResult, LogTailResult } from '@sim/contracts/logs';
import type { Logger } from '../log';
import { backoffMs, errorMessage, sleep } from '../util';
import { readSse } from './sse';

export type StreamItem = { type: 'entry'; entry: LogEntry } | { type: 'reset' };

export interface FollowOptions {
  severity?: string;
  signal: AbortSignal;
  /** Resume after this seq (undefined = live). */
  afterSeq?: number;
  /** Force the long-poll transport. */
  longPoll?: boolean;
}

export class LogStreamClient {
  /** Last seq delivered, for resuming. */
  lastSeq: number | undefined;
  transport: 'sse' | 'long-poll' = 'sse';

  constructor(
    private readonly baseUrl: string,
    private readonly log: Logger,
  ) {}

  /** Recent history for baseline learning: WARNING+ entries from the last `sinceSec`, oldest first. */
  async history(sinceSec: number, severity = 'WARNING', maxPages = 20): Promise<LogEntry[]> {
    const out: LogEntry[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams({
        since: `${Math.ceil(sinceSec / 60)}m`,
        severity,
        order: 'asc',
        limit: '500',
      });
      if (cursor) params.set('cursor', cursor);
      const res = await fetch(`${this.baseUrl}/api/logs?${params}`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`log history → HTTP ${res.status}`);
      const body = (await res.json()) as LogSearchResult;
      out.push(...body.items);
      this.lastSeq = Math.max(this.lastSeq ?? 0, body.last_seq);
      cursor = body.next_cursor;
      if (!cursor) break;
    }
    return out;
  }

  async *follow(opts: FollowOptions): AsyncGenerator<StreamItem> {
    if (opts.afterSeq !== undefined) this.lastSeq = opts.afterSeq;
    let failures = 0;
    if (opts.longPoll) this.transport = 'long-poll';
    while (!opts.signal.aborted) {
      try {
        const source = this.transport === 'sse' ? this.followSse(opts) : this.followTail(opts);
        for await (const item of source) {
          failures = 0;
          yield item;
        }
      } catch (err) {
        if (opts.signal.aborted) break;
        failures++;
        this.log.warn(`log stream (${this.transport}) dropped: ${errorMessage(err)}`);
        if (this.transport === 'sse' && failures >= 3) {
          this.transport = 'long-poll';
          this.log.warn('log stream: falling back to long-poll tail');
        }
        await sleep(backoffMs(Math.min(failures, 5), 500, 15_000), opts.signal);
      }
    }
  }

  private async *followSse(opts: FollowOptions): AsyncGenerator<StreamItem> {
    const params = new URLSearchParams({ severity: opts.severity ?? 'WARNING' });
    const headers: Record<string, string> = { accept: 'text/event-stream' };
    if (this.lastSeq !== undefined) headers['last-event-id'] = String(this.lastSeq);
    const res = await fetch(`${this.baseUrl}/api/logs/stream?${params}`, {
      headers,
      signal: opts.signal,
    });
    if (!res.ok || !res.body) throw new Error(`stream → HTTP ${res.status}`);
    for await (const ev of readSse(res.body, opts.signal)) {
      if (ev.event === 'reset') {
        this.lastSeq = undefined;
        yield { type: 'reset' };
        continue;
      }
      if (ev.event !== 'log') continue;
      const entry = JSON.parse(ev.data) as LogEntry;
      if (this.lastSeq !== undefined && entry.seq <= this.lastSeq) continue;
      this.lastSeq = entry.seq;
      yield { type: 'entry', entry };
    }
    if (!opts.signal.aborted) throw new Error('stream ended');
  }

  private async *followTail(opts: FollowOptions): AsyncGenerator<StreamItem> {
    while (!opts.signal.aborted) {
      const params = new URLSearchParams({
        severity: opts.severity ?? 'WARNING',
        wait_seconds: '25',
        limit: '500',
      });
      if (this.lastSeq !== undefined) params.set('after_seq', String(this.lastSeq));
      const res = await fetch(`${this.baseUrl}/api/logs/tail?${params}`, {
        signal: AbortSignal.any([opts.signal, AbortSignal.timeout(40_000)]),
      });
      if (!res.ok) throw new Error(`tail → HTTP ${res.status}`);
      const body = (await res.json()) as LogTailResult;
      if (this.lastSeq !== undefined && body.last_seq < this.lastSeq) {
        // The store restarted below our cursor: the world was reset.
        this.lastSeq = body.last_seq;
        yield { type: 'reset' };
        continue;
      }
      for (const entry of body.items) yield { type: 'entry', entry };
      this.lastSeq = body.cursor;
    }
  }
}
