/**
 * Case persistence: one JSON file per case at `<dataDir>/cases/<id>/case.json` (the same folder
 * holds that case's LLM transcripts). Writes are atomic (temp file + rename), so a crash never
 * leaves half a case behind. Listeners hear every change (the live timeline, #27).
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { isoNow } from '../util';
import {
  Case,
  type CaseInput,
  isTerminal,
  MAX_TIMELINE,
  type Phase,
  type TimelineEvent,
} from './types';

export type CaseListener = (c: Case, event?: TimelineEvent) => void;

let seq = 0;
function newCaseId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  seq = (seq + 1) % 1000;
  return `case-${stamp}-${randomBytes(2).toString('hex')}${seq}`;
}

export class CaseStore {
  private readonly cases = new Map<string, Case>();
  private readonly listeners = new Set<CaseListener>();
  readonly casesDir: string;

  constructor(dataDir: string) {
    this.casesDir = path.join(dataDir, 'cases');
  }

  /** Loads every case from disk (replacing memory). Returns them, newest first. */
  load(): Case[] {
    this.cases.clear();
    if (!existsSync(this.casesDir)) return [];
    for (const id of readdirSync(this.casesDir)) {
      const file = path.join(this.casesDir, id, 'case.json');
      if (!existsSync(file)) continue;
      try {
        const parsed = Case.safeParse(JSON.parse(readFileSync(file, 'utf8')));
        if (parsed.success) this.cases.set(parsed.data.id, parsed.data);
      } catch {
        // A corrupt file is skipped, never fatal.
      }
    }
    return this.all();
  }

  all(): Case[] {
    return [...this.cases.values()].sort((a, b) => b.opened_at.localeCompare(a.opened_at));
  }

  open(): Case[] {
    return this.all().filter((c) => !isTerminal(c.phase));
  }

  get(id: string): Case | undefined {
    return this.cases.get(id);
  }

  create(
    input: Omit<CaseInput, 'id' | 'opened_at' | 'updated_at' | 'correlation_id' | 'phase'> & {
      phase?: Phase;
    },
  ): Case {
    const now = isoNow();
    const c = Case.parse({
      phase: 'detected',
      ...input,
      id: newCaseId(),
      opened_at: now,
      updated_at: now,
      correlation_id: `agent-case:${randomBytes(6).toString('hex')}`,
    });
    this.cases.set(c.id, c);
    this.event(c, 'phase', `Case opened (${c.kind})`);
    return c;
  }

  /** Persists a case (atomically) and notifies listeners. */
  save(c: Case, event?: TimelineEvent): void {
    c.updated_at = isoNow();
    if (c.timeline.length > MAX_TIMELINE) c.timeline.splice(0, c.timeline.length - MAX_TIMELINE);
    this.cases.set(c.id, c);
    const dir = path.join(this.casesDir, c.id);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'case.json');
    const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(c, null, 2));
    renameSync(tmp, file);
    for (const fn of this.listeners) {
      try {
        fn(c, event);
      } catch {
        // listeners must not break persistence
      }
    }
  }

  /** Appends a timeline event and saves. */
  event(
    c: Case,
    kind: TimelineEvent['kind'],
    text: string,
    extra: { url?: string; data?: unknown } = {},
  ): TimelineEvent {
    const event: TimelineEvent = { at: isoNow(), kind, text, ...extra };
    c.timeline.push(event);
    this.save(c, event);
    return event;
  }

  setPhase(c: Case, phase: Phase, why?: string): void {
    if (c.phase === phase) return;
    const from = c.phase;
    c.phase = phase;
    c.attempts[phase] = 0;
    c.milestones[phase] ??= isoNow();
    this.event(c, 'phase', `${from} → ${phase}${why ? `: ${why}` : ''}`, {
      data: { from, to: phase },
    });
  }

  subscribe(fn: CaseListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
