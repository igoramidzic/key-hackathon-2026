import type {
  ActivityEvent,
  ActivityKind,
  ActivityTable,
  ContactType,
} from '@sim/contracts/servicenow';
import type { ChangeRecord, ChangeStore } from './changes';
import type { IncidentStore } from './incidents';
import type { IncidentRecord, JournalRecord } from './model';

export interface ActivityFilter {
  tables?: ActivityTable[];
  kinds?: ActivityKind[];
  appTlas?: string[];
  contactTypes?: ContactType[];
}

type Rec =
  | { table: 'incident'; rec: IncidentRecord }
  | { table: 'change_request'; rec: ChangeRecord };

/** `jrn_000123` → 123. Journal ids come from one generator shared by incidents and changes. */
export const journalSeq = (id: string) => Number(id.slice(id.lastIndexOf('_') + 1)) || 0;

/**
 * Arrival-ordered feed of every journal entry (opened, field changes, work notes, comments) on
 * incidents and change requests. Derived from the journals on read, so every write path is
 * covered without hooks; the app calls `wake()` after each write to release waiting readers.
 */
export class ActivityFeed {
  private waiters = new Set<() => void>();

  constructor(
    private readonly incidents: IncidentStore,
    private readonly changes: ChangeStore,
  ) {}

  get lastSeq() {
    return this.incidents.lastJournalSeq;
  }

  get epoch() {
    return this.incidents.epoch;
  }

  get subscribers() {
    return this.waiters.size;
  }

  /**
   * Up to `limit` matching events with seq > afterSeq, in seq order. `cursor` is where to
   * continue: the last returned seq when the page is full, otherwise `lastSeq`.
   */
  readAfter(
    afterSeq: number,
    filter: ActivityFilter,
    limit: number,
  ): { items: ActivityEvent[]; cursor: number; hasMore: boolean } {
    // A cursor from before a reset or restart may be ahead of us: clamp it.
    const after = Math.min(Math.max(afterSeq, 0), this.lastSeq);
    const hits: { seq: number; r: Rec; entry: JournalRecord; first: boolean }[] = [];
    for (const r of this.candidates(filter)) {
      const journal = r.rec.journal;
      // Journals are append-only in seq order: skip records with nothing new.
      const last = journal[journal.length - 1];
      if (!last || journalSeq(last.id) <= after) continue;
      for (let i = journal.length - 1; i >= 0; i--) {
        const entry = journal[i]!;
        const seq = journalSeq(entry.id);
        if (seq <= after) break;
        hits.push({ seq, r, entry, first: i === 0 });
      }
    }
    hits.sort((a, b) => a.seq - b.seq);
    const items: ActivityEvent[] = [];
    for (const h of hits) {
      const kind = kindOf(h.r.table, h.entry, h.first);
      if (filter.kinds && !filter.kinds.includes(kind)) continue;
      if (items.length >= limit) {
        return { items, cursor: items[items.length - 1]!.seq, hasMore: true };
      }
      items.push(this.event(h.seq, kind, h.r, h.entry));
    }
    return { items, cursor: this.lastSeq, hasMore: false };
  }

  /** The latest `limit` matching events, in seq order. */
  latest(filter: ActivityFilter, limit: number): ActivityEvent[] {
    // Walk back in growing windows until we have enough (or reach the start).
    let span = Math.max(limit * 4, 200);
    for (;;) {
      const from = Math.max(0, this.lastSeq - span);
      const r = this.readAfter(from, filter, Number.MAX_SAFE_INTEGER);
      if (r.items.length >= limit || from === 0) return r.items.slice(-limit);
      span *= 4;
    }
  }

  waitForActivity(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve(false);
      const done = (value: boolean) => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const wake = () => done(true);
      const onAbort = () => done(false);
      const timer = setTimeout(() => done(false), timeoutMs);
      this.waiters.add(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  wake() {
    for (const w of [...this.waiters]) w();
  }

  private *candidates(filter: ActivityFilter): Generator<Rec> {
    const want = (t: ActivityTable) => !filter.tables || filter.tables.includes(t);
    const tlaOk = (tla: string | null) =>
      !filter.appTlas || (tla !== null && filter.appTlas.includes(tla));
    if (want('incident')) {
      for (const rec of this.incidents.records) {
        if (!tlaOk(rec.app_tla)) continue;
        if (filter.contactTypes && !filter.contactTypes.includes(rec.contact_type)) continue;
        yield { table: 'incident', rec };
      }
    }
    // contact_type only exists on incidents: filtering by it means incidents only.
    if (want('change_request') && !filter.contactTypes) {
      for (const rec of this.changes.records) {
        if (!tlaOk(rec.app_tla)) continue;
        yield { table: 'change_request', rec };
      }
    }
  }

  private event(seq: number, kind: ActivityKind, r: Rec, entry: JournalRecord): ActivityEvent {
    const base = {
      seq,
      kind,
      table: r.table,
      number: r.rec.number,
      app_tla: r.rec.app_tla,
      at: entry.created_at,
    };
    if (r.table === 'incident') {
      return {
        ...base,
        entry: this.incidents.journalEntry(entry),
        incident: this.incidents.summary(r.rec),
      };
    }
    return {
      ...base,
      entry: this.changes.journalEntry(entry),
      change_request: this.changes.summary(r.rec),
    };
  }
}

function kindOf(table: ActivityTable, entry: JournalRecord, first: boolean): ActivityKind {
  if (entry.type === 'system') return `${table}.${first ? 'opened' : 'updated'}`;
  return `${table}.${entry.type}`;
}
