import { useEffect, useState } from 'react';
import type { AgentInfo, CaseView } from './types';

export type AgentStatus = 'connecting' | 'live' | 'down';

export interface AgentFeed {
  status: AgentStatus;
  info: AgentInfo | null;
  cases: Map<string, CaseView>;
}

const KEY = 'demo.agent';

/** Where the agent's live timeline is: `?agent=`, the last one used, or the default port. */
export function agentBase(): string {
  const fromUrl = new URLSearchParams(window.location.search).get('agent');
  let stored: string | null = null;
  try {
    if (fromUrl) localStorage.setItem(KEY, fromUrl);
    stored = localStorage.getItem(KEY);
  } catch {
    // private mode: use the default
  }
  return (fromUrl || stored || 'http://localhost:4100').replace(/\/+$/, '');
}

/** The agent's cases, live over SSE (`/api/stream`), reconnecting by itself. */
export function useAgent(base: string): AgentFeed {
  const [status, setStatus] = useState<AgentStatus>('connecting');
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [cases, setCases] = useState<Map<string, CaseView>>(() => new Map());

  useEffect(() => {
    const es = new EventSource(`${base}/api/stream`);
    const parse = <T>(e: Event): T | null => {
      try {
        return JSON.parse((e as MessageEvent).data) as T;
      } catch {
        return null;
      }
    };
    es.addEventListener('open', () => {
      setStatus('live');
      fetch(`${base}/api/info`)
        .then((r) => (r.ok ? r.json() : null))
        .then((i: AgentInfo | null) => setInfo(i))
        .catch(() => setInfo(null));
    });
    es.addEventListener('error', () => setStatus('down'));
    es.addEventListener('snapshot', (e) => {
      const data = parse<{ cases: CaseView[] }>(e);
      if (data) setCases(new Map(data.cases.map((c) => [c.id, c])));
    });
    es.addEventListener('case', (e) => {
      const c = parse<CaseView>(e);
      if (c) setCases((prev) => new Map(prev).set(c.id, c));
    });
    es.addEventListener('removed', (e) => {
      const data = parse<{ id: string }>(e);
      if (!data) return;
      setCases((prev) => {
        const next = new Map(prev);
        next.delete(data.id);
        return next;
      });
    });
    return () => es.close();
  }, [base]);

  return { status, info, cases };
}

/**
 * The case the demo follows: the one the agent opened for this run. A run can open more than one
 * (they are merged later), so follow `Merged into` and prefer the case that has gone furthest.
 */
export function pickCase(cases: Map<string, CaseView>, sinceMs: number | null): CaseView | null {
  if (sinceMs === null) return null;
  const fresh = [...cases.values()].filter(
    (c) => Date.parse(c.opened_at) >= sinceMs - 3_000 && c.phase !== 'abandoned',
  );
  if (fresh.length === 0) return null;
  const score = (c: CaseView) =>
    (c.records?.incident ? 1_000 : 0) + c.apps.length * 10 + c.timeline.length / 1_000;
  let best = fresh.reduce((a, b) => (score(b) > score(a) ? b : a));
  for (let hop = 0; hop < 4; hop++) {
    const into = best.related.find((r) => r.label === 'Merged into');
    const next = into ? cases.get(into.id) : undefined;
    if (!next) break;
    best = next;
  }
  return best;
}
