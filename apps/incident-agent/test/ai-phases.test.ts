/** AI-first phases with a fake model: verification of what the model says, and labelled fallbacks. */
import { describe, expect, it } from 'vitest';
import type { Case } from '../src/cases/types';
import { handleMessage } from '../src/flow/chat';
import { deepRca, quickRcaPhase } from '../src/flow/rca';
import type { PhaseRunner, PhaseSpec } from '../src/phases/runner';
import { flowDeps } from './helpers';

const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0.01, turns: 3, durationMs: 1 };

function fakeRunner(answer: (spec: PhaseSpec<unknown>) => unknown | Error) {
  const specs: PhaseSpec<unknown>[] = [];
  const runner = {
    models: { fast: 'claude-sonnet-5-5', deep: 'claude-opus-5-5' },
    run: async (spec: PhaseSpec<unknown>) => {
      specs.push(spec);
      const value = answer(spec);
      if (value instanceof Error)
        return { ok: false as const, error: value.message, usage, attempts: 1, transcripts: [] };
      return {
        ok: true as const,
        value: spec.schema.parse(value),
        usage,
        attempts: 1,
        transcripts: [],
      };
    },
  } as unknown as PhaseRunner;
  return { runner, specs };
}

function world() {
  const deps = flowDeps();
  deps.mcp
    .on('get_change_request', (a) =>
      a.number === 'CHG0030081'
        ? {
            number: 'CHG0030081',
            web_url: 'http://sn.real/CHG0030081',
            implemented_at: '2026-11-11T19:12:00Z',
            merge_requests: [
              {
                reference: 'keybank/CIF00/customer-profile-api!9',
                title: 'Adopt naming standard',
                web_url: 'http://gl.real/mr/9',
              },
            ],
          }
        : new Error('Change request CHG9999999 not found'),
    )
    .on('get_merge_request', () => ({
      project: 'keybank/CIF00/customer-profile-api',
      iid: 9,
      title: 'Adopt naming standard',
      author: 'jdoe',
      state: 'merged',
      merged_at: '2026-11-11T19:05:00Z',
      merge_commit_sha: 'abc',
      web_url: 'http://gl.real/mr/9',
      changes: [],
    }))
    .on('list_change_requests', () => ({ items: [] }))
    .on('list_merge_requests', () => ({ items: [] }));
  const c = deps.store.create({
    kind: 'monitoring',
    apps: ['OLB', 'MBL'],
    onset_at: '2026-11-11T19:14:00Z',
  }) as Case;
  c.upstream_candidates = deps.graph().commonUpstream(c.apps);
  return { deps, c };
}

const suspect = (number: string, url: string) => ({
  tla: 'CIF',
  change_request: { number, web_url: url },
  merge_request: null,
  promoted_at: null,
  author: null,
  reason: 'every failing app calls CIF; the diff renames customerId',
  confidence: 0.85,
});

describe('AI quick RCA', () => {
  it('keeps only changes that exist, with links and times from the tools', async () => {
    const { deps, c } = world();
    const { runner, specs } = fakeRunner(() => ({
      suspects: [
        suspect('CHG0030081', 'http://made.up/CHG0030081'),
        suspect('CHG9999999', 'http://made.up/x'),
      ],
    }));
    deps.runner = runner;
    const { suspects, source } = await quickRcaPhase(deps, c);
    expect(source).toBe('llm');
    expect(suspects).toHaveLength(1);
    expect(suspects[0]).toMatchObject({
      change_request: { number: 'CHG0030081', web_url: 'http://sn.real/CHG0030081' },
      merge_request: {
        project: 'keybank/CIF00/customer-profile-api',
        iid: 9,
        web_url: 'http://gl.real/mr/9',
      },
      promoted_at: '2026-11-11T19:12:00Z',
      author: 'jdoe',
    });
    expect(specs[0]!.name).toBe('quick_rca');
    expect(specs[0]!.tools).not.toContain('create_incident');
  });

  it('falls back to the deterministic ranking (and says so) when the model fails', async () => {
    const { deps, c } = world();
    deps.runner = fakeRunner(() => new Error('Failed to authenticate')).runner;
    const { source } = await quickRcaPhase(deps, c);
    expect(source).toBe('heuristic');
    expect(c.timeline.some((e) => e.kind === 'llm' && e.text.includes('AI quick RCA failed'))).toBe(
      true,
    );
  });
});

describe('AI deep RCA', () => {
  it('investigates on its own: no deterministic draft in the prompt, Opus, verified references', async () => {
    const { deps, c } = world();
    const { runner, specs } = fakeRunner(() => ({
      culprit_tla: 'CIF',
      change_request: { number: 'CHG0030081', web_url: 'http://made.up' },
      merge_request: {
        project: 'keybank/CIF00/customer-profile-api',
        iid: 9,
        title: 'x',
        web_url: 'http://made.up',
      },
      commit: null,
      files: ['application.yml'],
      mechanism: 'snake_case breaks the callers',
      evidence: [
        { claim: 'promoted at 19:12', web_url: 'http://localhost:3002/change_requests/CHG0030081' },
      ],
      ruled_out: [],
      unexplained_apps: [],
      confidence: 0.9,
    }));
    deps.runner = runner;
    const { rootCause, source } = await deepRca(deps, c);
    expect(source).toBe('llm');
    expect(rootCause?.change_request?.web_url).toBe('http://sn.real/CHG0030081');
    expect(rootCause?.merge_request?.web_url).toBe('http://gl.real/mr/9');
    expect(specs[0]!.model).toBe('claude-opus-5-5');
    expect(specs[0]!.prompt).not.toContain('Deterministic draft');
  });

  it('falls back when the model names an app that does not exist', async () => {
    const { deps, c } = world();
    deps.runner = fakeRunner(() => ({
      culprit_tla: 'ZZQ',
      change_request: null,
      merge_request: null,
      commit: null,
      files: [],
      mechanism: 'x',
      evidence: [],
      ruled_out: [],
      unexplained_apps: [],
      confidence: 0.9,
    })).runner;
    const { source } = await deepRca(deps, c);
    expect(source).toBe('heuristic');
  });
});

describe('AI chat', () => {
  it('uses the model to classify messages', async () => {
    const { deps, c } = world();
    c.channel = { id: 'ch_1', name: 'inc-x', web_url: 'http://teams.test/ch_1' };
    deps.mcp.on('post_message', () => ({ id: 'm' })).on('add_incident_note', () => ({}));
    deps.runner = fakeRunner((spec) =>
      spec.name === 'chat_classify'
        ? { intent: 'correction', tla: 'ath' }
        : { answer: 'x', links: [] },
    ).runner;
    const hints: string[] = [];
    const intent = await handleMessage(
      deps,
      c,
      {
        id: 'msg_1',
        author: 'kstreich',
        created_at: '',
        body: 'hmm, I would look at the auth deploy instead',
        kind: 'message',
      },
      { rerunRca: (_c, h) => hints.push(h), checkMerge: () => {}, regroup: async () => '' },
    );
    expect(intent).toBe('correction');
    expect(hints).toEqual(['hmm, I would look at the auth deploy instead']);
  });
});
