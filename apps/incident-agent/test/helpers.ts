/** Shared test scaffolding for flow steps: a store, the real CMDB graph and a fake MCP. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StepContext } from '../src/cases/orchestrator';
import { CaseStore } from '../src/cases/store';
import type { Case, LogSignal } from '../src/cases/types';
import { loadConfig } from '../src/config';
import { type AppNode, DependencyGraph } from '../src/correlate/graph';
import type { FlowDeps } from '../src/flow/steps';
import { silent } from '../src/log';
import type { PhaseRunner } from '../src/phases/runner';
import { FakeMcp } from './fakeMcp';
import graphFixture from './fixtures/graph.json';

export const realGraph = () =>
  DependencyGraph.fromEdges(
    graphFixture.nodes as AppNode[],
    graphFixture.edges as [string, string][],
  );

export function flowDeps(over: Partial<FlowDeps> & { env?: Record<string, string> } = {}) {
  const store = new CaseStore(mkdtempSync(path.join(tmpdir(), 'agent-flow-')));
  const mcp = new FakeMcp();
  const graph = realGraph();
  const deps: FlowDeps & { mcp: FakeMcp } = {
    config: loadConfig(over.env ?? {}),
    mcp,
    store,
    graph: () => graph,
    runner: null as PhaseRunner | null,
    log: silent,
    ...over,
  } as FlowDeps & { mcp: FakeMcp };
  return deps;
}

export function stepCtx(store: CaseStore): StepContext & { tracked: Case[]; spawned: string[] } {
  const tracked: Case[] = [];
  const spawned: string[] = [];
  const running = new Set<string>();
  return {
    store,
    log: silent,
    tracked,
    spawned,
    spawn: (c, name, fn) => {
      if (running.has(`${c.id}:${name}`)) return false;
      spawned.push(name);
      running.add(`${c.id}:${name}`);
      void fn(new AbortController().signal).finally(() => running.delete(`${c.id}:${name}`));
      return true;
    },
    isRunning: (c, name) => running.has(`${c.id}:${name}`),
    cancel: () => {},
    poke: () => {},
    track: (c) => tracked.push(c),
  };
}

let n = 0;
export function logSignal(app: string, over: Partial<LogSignal> = {}): LogSignal {
  n++;
  return {
    source: 'logs',
    id: `sig${n}`,
    at: '2026-11-11T19:14:05Z',
    app_tla: app,
    service: `${app.toLowerCase()}-api`,
    reason: 'spike',
    strength: 'strong',
    error_types: ['UpstreamContractError'],
    first_seen: '2026-11-11T19:14:00Z',
    count: 30,
    rate: 30,
    baseline: 0,
    sample_insert_ids: ['ins1'],
    traces: [],
    sample_messages: ['profile response failed validation'],
    filter: `severity>=ERROR labels.app_tla="${app}"`,
    ...over,
  };
}

/** search_logs that echoes the filter into a logs_url, like the real tool. */
export function echoSearch(mcp: FakeMcp, totals: (filter: string) => number = () => 42) {
  mcp.on('search_logs', (a) => ({
    total: totals(String(a.filter)),
    items: [],
    logs_url: `http://logs.test/logs?query=${encodeURIComponent(String(a.filter))}`,
  }));
}
