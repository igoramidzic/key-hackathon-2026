import { describe, expect, it } from 'vitest';
import type { HumanSignal, ScopeReport } from '../src/cases/types';
import { detected } from '../src/flow/steps';
import { discoverApps, heuristicScope, triage } from '../src/flow/triage';
import type { PhaseRunner } from '../src/phases/runner';
import { echoSearch, flowDeps, logSignal, stepCtx } from './helpers';

const fp = (app: string, count: number, first: string, over: Record<string, unknown> = {}) => ({
  app_tla: app,
  service: `${app.toLowerCase()}-api`,
  severity: 'ERROR',
  fingerprint: `${app}${count}`,
  pattern: `${app} customerId missing from profile response`,
  count,
  first_seen: first,
  last_seen: '2026-11-11T19:20:00Z',
  sample_message: `${app}: customerId missing from profile response`,
  sample_insert_id: `ins-${app}`,
  error_type: 'UpstreamContractError',
  ...over,
});

function cascadeDeps() {
  const deps = flowDeps();
  echoSearch(deps.mcp);
  deps.mcp
    .on('summarize_errors', () => ({
      total_matched: 300,
      items: [
        fp('OLB', 200, '2026-11-11T19:14:02Z'),
        fp('MBL', 90, '2026-11-11T19:14:05Z'),
        fp('MBL', 1, '2026-11-11T19:09:30Z', {
          pattern: 'client disconnected',
          error_type: 'ClientAbortException',
        }),
      ],
    }))
    .on('get_log_entry', (a) => ({
      jsonPayload: {
        error: { stack_trace: `at ${a.insert_id}\nat line2\nat line3\nat line4\nat line5` },
      },
    }))
    .on('list_log_services', () => ({ items: [{ error_rate: 0.3 }, { error_rate: 0.1 }] }));
  const c = deps.store.create({
    kind: 'monitoring',
    apps: ['OLB', 'MBL', 'GLD'],
    onset_at: '2026-11-11T19:14:00Z',
    signals: [logSignal('OLB'), logSignal('MBL')],
    relations: [
      { tla: 'OLB', score: 1, reasons: ['first signal'], tentative: false },
      { tla: 'MBL', score: 0.8, reasons: ['errors on both sides name CIF'], tentative: false },
      { tla: 'GLD', score: 0.4, reasons: ['shares upstream ATH'], tentative: true },
    ],
  });
  c.upstream_candidates = deps.graph().commonUpstream(['OLB', 'MBL']);
  return { deps, c };
}

describe('heuristic triage', () => {
  it('scopes the blast radius with onset, signatures, severity and real log links', async () => {
    const { deps, c } = cascadeDeps();
    const scope = await heuristicScope(deps, c);
    expect(scope.affected_apps.map((a) => a.tla)).toEqual(['OLB', 'MBL', 'GLD']);
    expect(scope.affected_apps[0]).toMatchObject({
      name: 'Online Banking',
      tier: 1,
      error_count: 200,
    });
    expect(scope.onset).toBe('2026-11-11T19:14:02Z');
    expect(scope.signatures[0]).toMatchObject({
      app_tla: 'OLB',
      error_type: 'UpstreamContractError',
    });
    expect(scope.signatures[0]!.stack_excerpt.split('\n')).toHaveLength(4);
    expect(scope.suggested_impact).toBe(1);
    expect(scope.suggested_urgency).toBe(1);
    expect(scope.summary).toContain('Online Banking');

    // Every link is the logs_url search_logs returned for that filter, and pins the start time.
    const searched = deps.mcp.callsTo('search_logs').map((a) => String(a.filter));
    expect(scope.log_links.length).toBeGreaterThanOrEqual(2);
    for (const link of scope.log_links) {
      expect(searched).toContain(link.filter);
      expect(link.logs_url).toBe(`http://logs.test/logs?query=${encodeURIComponent(link.filter)}`);
      expect(link.filter).toContain('timestamp>="2026-11-11T19:12:00.000Z"');
    }
    expect(scope.log_links[0]!.filter).toContain('labels.app_tla=("OLB" OR "MBL")');
    expect(scope.log_links[1]!.filter).toContain('jsonPayload.error.type="UpstreamContractError"');
  });

  it('confirms solid joins and rejects a tentative app with no errors', async () => {
    const { deps, c } = cascadeDeps();
    const scope = await heuristicScope(deps, c);
    const g = Object.fromEntries(scope.grouping.map((x) => [x.tla, x]));
    expect(g.OLB!.belongs).toBe(true);
    expect(g.MBL!.belongs).toBe(true);
    expect(g.GLD!.belongs).toBe(false);
    expect(g.GLD!.reason).toContain('no errors');
  });

  it('the detected step waits for the settle window, then triages and splits unrelated apps', async () => {
    const { deps, c } = cascadeDeps();
    const ctx = stepCtx(deps.store);
    c.settle_until = new Date(Date.now() + 5_000).toISOString();
    const wait = await detected(deps)(c, ctx);
    expect(wait && 'wait' in wait && wait.wait).toBeGreaterThan(0);
    c.settle_until = new Date(Date.now() - 1).toISOString();
    const next = await detected(deps)(c, ctx);
    expect(next).toMatchObject({ next: 'triaged' });
    expect(c.scope?.summary).toBeTruthy();
    expect(c.apps).toEqual(['OLB', 'MBL']);
    expect(ctx.tracked).toHaveLength(1);
    expect(ctx.tracked[0]!.apps).toEqual(['GLD']);
    expect(ctx.tracked[0]!.split_from).toBe(c.id);
  });
});

describe('human-reported triage', () => {
  const call = (n: string, text: string, location: string): HumanSignal => ({
    source: 'human',
    id: `h${n}`,
    at: '2026-11-11T19:22:28Z',
    incident_number: n,
    short_description: text,
    description: '',
    caller: 'mlopez',
    location,
    contact_type: 'phone',
    app_tla: null,
    impact: 2,
    urgency: 2,
    web_url: `http://sn/${n}`,
  });

  it('finds the apps behind the calls from new warning patterns and the callers’ words', async () => {
    const deps = flowDeps();
    deps.mcp.on('summarize_errors', () => ({
      total_matched: 50,
      items: [
        fp('TLR', 40, '2026-11-11T19:21:40Z', {
          severity: 'WARNING',
          pattern: 'business date <d> ahead of calendar date',
        }),
        fp('PAY', 30, '2026-11-11T19:03:00Z', { severity: 'WARNING', pattern: 'slow request <n>' }),
      ],
    }));
    const c = deps.store.create({
      kind: 'human-reported',
      onset_at: '2026-11-11T19:22:28Z',
      signals: [
        call('INC1', 'Teller transactions posting with next business date', 'Cleveland'),
        call('INC2', 'Receipt printer printing tomorrow’s date', 'Lakewood'),
      ],
    });
    const found = await discoverApps(deps, c);
    expect(found.apps[0]).toBe('TLR');
    expect(found.apps).not.toContain('PAY'); // a pattern that predates the calls is background
    expect(found.reasons.get('TLR')!.join(' ')).toContain('new pattern');
  });
});

describe('LLM triage', () => {
  it('uses the model’s prose but re-resolves any link it changed through search_logs', async () => {
    const { deps, c } = cascadeDeps();
    const fakeRunner = {
      models: { fast: 'f', deep: 'd' },
      run: async () => {
        const draft = await heuristicScope(deps, c);
        const value: ScopeReport = {
          ...draft,
          summary: 'Online and mobile banking customer lookups failing',
          log_links: [
            {
              label: 'made up',
              filter: 'severity>=ERROR labels.app_tla="OLB"',
              logs_url: 'http://evil.example/logs',
            },
          ],
        };
        return {
          ok: true as const,
          value,
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, turns: 1, durationMs: 1 },
          attempts: 1,
          transcripts: [],
        };
      },
    } as unknown as PhaseRunner;
    deps.runner = fakeRunner;
    const { scope, source } = await triage(deps, c);
    expect(source).toBe('llm');
    expect(scope.summary).toBe('Online and mobile banking customer lookups failing');
    expect(scope.log_links[0]!.logs_url).toBe(
      `http://logs.test/logs?query=${encodeURIComponent('severity>=ERROR labels.app_tla="OLB"')}`,
    );
  });

  it('falls back to the log-derived scope when the phase fails', async () => {
    const { deps, c } = cascadeDeps();
    deps.runner = {
      models: { fast: 'f', deep: 'd' },
      run: async () => ({
        ok: false,
        error: 'timed out',
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 0, durationMs: 0 },
        attempts: 1,
        transcripts: [],
      }),
    } as unknown as PhaseRunner;
    const { source, scope } = await triage(deps, c);
    expect(source).toBe('heuristic');
    expect(scope.affected_apps.length).toBe(3);
  });
});
