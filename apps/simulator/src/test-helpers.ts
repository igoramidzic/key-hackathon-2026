import type { AdminMergeResult, CommitRef, FileEdit } from '@sim/contracts/gitlab';
import type { Alert, AlertInput, AlertUpdate, LogEntryInput } from '@sim/contracts/logs';
import type { IncidentCreateInput, IncidentRef } from '@sim/contracts/servicenow';
import type { ScenarioDefinition } from '@sim/scenarios';
import { getApp, shaFor } from '@sim/world';
import type { SimulatorConfig, Systems } from './systems';
import { loadConfig } from './systems';

/** In-memory stand-ins for the four systems, recording every call. */
export function fakeSystems(seedFiles: Record<string, string> = {}) {
  const files = new Map(Object.entries(seedFiles));
  const ingested: LogEntryInput[] = [];
  const merges: { project: string; title: string; edits: FileEdit[]; sha: string }[] = [];
  const commits: { project: string; message: string; edits: FileEdit[]; sha: string }[] = [];
  const raised: AlertInput[] = [];
  const updates: ({ id: number } & AlertUpdate)[] = [];
  const incidents: IncidentCreateInput[] = [];
  const resets: string[] = [];
  const alertIds = new Map<string, number>();
  let nextAlert = 48_000;
  let nextIid = 1;
  let nextInc = 10_042;
  let ingestFails = 0;
  let lastMain: { title: string; sha: string; web_url: string } | null = null;

  const applyEdits = (project: string, edits: FileEdit[]) => {
    for (const e of edits) {
      const key = `${project}:${e.path}`;
      if (e.content !== undefined) {
        files.set(key, e.content);
        continue;
      }
      const current = files.get(key);
      if (current === undefined || e.find === undefined || current.split(e.find).length !== 2) {
        throw new Error(`422: find not found exactly once in ${e.path}`);
      }
      files.set(key, current.replace(e.find, e.replace ?? ''));
    }
  };
  const commitRef = (sha: string, title: string, author: string, url: string): CommitRef => ({
    id: sha,
    short_id: sha.slice(0, 8),
    title,
    author_username: author,
    created_at: new Date().toISOString(),
    web_url: url,
  });

  const systems: Systems = {
    logs: {
      ingest: async ({ entries }) => {
        if (ingestFails > 0) {
          ingestFails--;
          throw new Error('logs-api down');
        }
        ingested.push(...entries);
        return { accepted: entries.length, last_seq: ingested.length };
      },
      raiseAlert: async (input) => {
        raised.push(input);
        let id = alertIds.get(input.dedupe_key);
        if (!id) {
          id = nextAlert++;
          alertIds.set(input.dedupe_key, id);
        }
        return { ...input, id, status: 'open', event_count: 1 } as unknown as Alert;
      },
      updateAlert: async (id, update) => {
        updates.push({ id, ...update });
        return { id } as Alert;
      },
      reset: async () => {
        resets.push('logs');
        return { ok: true, service: 'logs-api', reset_at: new Date().toISOString() };
      },
    },
    servicenow: {
      createIncident: async (input): Promise<IncidentRef> => {
        incidents.push(input);
        const number = `INC00${nextInc++}`;
        return {
          sys_id: shaFor(number).slice(0, 32),
          number,
          short_description: input.short_description,
          web_url: `http://localhost:3002/incidents/${number}`,
        };
      },
      reset: async () => {
        resets.push('servicenow');
        return { ok: true, service: 'servicenow-api', reset_at: new Date().toISOString() };
      },
    },
    gitlab: {
      adminMerge: async (input): Promise<AdminMergeResult> => {
        applyEdits(input.project, input.edits);
        const iid = nextIid++;
        const sha = shaFor(`merge:${input.project}:${iid}`);
        const web_url = `http://localhost:3003/${input.project}/-/merge_requests/${iid}`;
        merges.push({ project: input.project, title: input.title, edits: input.edits, sha });
        lastMain = { title: input.title, sha, web_url };
        return {
          project: input.project,
          iid,
          web_url,
          merge_commit: commitRef(sha, input.title, input.merged_by, web_url),
        };
      },
      adminCommit: async (input) => {
        applyEdits(input.project, input.edits);
        const sha = shaFor(`commit:${input.project}:${commits.length}`);
        commits.push({ project: input.project, message: input.message, edits: input.edits, sha });
        const url = `http://localhost:3003/${input.project}/-/commit/${sha}`;
        lastMain = { title: input.message, sha, web_url: url };
        return commitRef(sha, input.message, input.author, url);
      },
      getRawFile: async (project, path) => files.get(`${project}:${path}`) ?? null,
      latestMainChange: async () => lastMain,
      reset: async () => {
        resets.push('gitlab');
        return { ok: true, service: 'gitlab-api', reset_at: new Date().toISOString() };
      },
    },
    teams: {
      reset: async () => {
        resets.push('teams');
        return { ok: true, service: 'teams-api', reset_at: new Date().toISOString() };
      },
    },
  };

  return {
    systems,
    files,
    ingested,
    merges,
    commits,
    raised,
    updates,
    incidents,
    resets,
    applyEdits,
    failNextIngests: (n: number) => {
      ingestFails = n;
    },
  };
}

export const CIF_PROJECT = 'keybank/CIF00/customer-profile-api';
export const CONFIG_PATH = 'src/main/resources/application.yml';

/** A small cascade scenario: CIF pool shrink → PAY and OLB errors, fanout to CIF consumers. */
export function testScenario(overrides: Partial<ScenarioDefinition> = {}): ScenarioDefinition {
  const cif = getApp('CIF');
  const pay = getApp('PAY');
  return {
    id: 'test-cif-pool',
    title: 'CIF connection pool shrink',
    kind: 'cascade',
    summary: 'Payments and online banking fail while CIF looks healthy.',
    answerKey: {
      rootCause: 'MR shrank the CIF Hikari pool to 2 connections.',
      culpritTla: 'CIF',
      affectedTlas: ['PAY', 'OLB'],
      whyItLooksGreen: 'CIF health checks do not touch the database.',
    },
    badMr: {
      project: CIF_PROJECT,
      title: 'Tune Hikari pool for lower DB load',
      description: 'Reduce pool size.',
      author: cif.developerUsernames[0]!,
      mergedBy: cif.developerUsernames[1]!,
      sourceBranch: 'perf/hikari-pool',
      labels: ['performance'],
      edits: [
        { path: CONFIG_PATH, find: 'maximum-pool-size: 20', replace: 'maximum-pool-size: 2' },
      ],
    },
    fix: {
      title: 'Restore Hikari pool size',
      description: 'Back to 20.',
      edits: [
        { path: CONFIG_PATH, find: 'maximum-pool-size: 2\n', replace: 'maximum-pool-size: 20\n' },
      ],
      files: [CONFIG_PATH],
      isFixed: (f) => !/maximum-pool-size: 2\n/.test(f[CONFIG_PATH] ?? ''),
    },
    faultOnsetSec: 30,
    culpritSignals: {
      ratePerSec: 1,
      templates: [
        {
          severity: 'WARNING',
          render: () => ({
            message: 'HikariPool-1 - Connection is not available, request timed out after 30000ms',
          }),
        },
      ],
    },
    impacts: [
      {
        tla: 'PAY',
        startAfterSec: 10,
        ratePerSec: 4,
        templates: [
          {
            severity: 'ERROR',
            weight: 3,
            render: (ctx) => ({
              message: `CIF lookup failed for customer ${ctx.customerId()}`,
              logger: 'c.k.pay.client.CifClient',
              httpRequest: {
                requestMethod: 'POST',
                requestUrl: '/v1/payments',
                status: 503,
                latencySec: 5.01,
              },
            }),
          },
          {
            severity: 'WARNING',
            render: (ctx) => ({ message: `Retrying CIF (elapsed ${Math.round(ctx.elapsedSec)}s)` }),
          },
        ],
      },
      {
        tla: 'OLB',
        startAfterSec: 20,
        ratePerSec: 2,
        templates: [{ severity: 'ERROR', render: () => ({ message: 'profile load failed' }) }],
      },
    ],
    fanout: [
      {
        upstreamTla: 'CIF',
        startAfterSec: 30,
        ratePerSec: 0.5,
        templates: (app, stack) => [
          {
            severity: 'ERROR',
            render: () => ({ message: `${app.tla} (${stack}): customer lookup timed out` }),
          },
        ],
      },
    ],
    alerts: [
      {
        atSec: 60,
        repeatEverySec: 60,
        alert: {
          severity: 'critical',
          description: 'HTTP 5xx rate 31% on payments-api (threshold 5%)',
          source: 'payments-api',
          service: pay.runtime.service,
          app_tla: 'PAY',
          manager: 'AppDynamics',
          class: 'Application',
          check: 'http_5xx_rate',
          dedupe_key: 'pay:5xx',
        },
      },
    ],
    helpdesk: [
      {
        atSec: 90,
        incident: {
          short_description: 'Branch cannot load customer profiles',
          caller: 'mlopez',
          app_tla: 'TLR',
        },
      },
    ],
    redHerrings: [
      {
        atSec: 15,
        kind: 'merge',
        project: 'keybank/PAY00/payments-api',
        title: 'Bump logback to 1.5.12',
        author: pay.developerUsernames[0]!,
        edits: [{ path: 'docs/notes.md', content: 'logback bump' }],
      },
    ],
    ...overrides,
  };
}

export const seedFiles = () => ({
  [`${CIF_PROJECT}:${CONFIG_PATH}`]:
    'spring:\n  datasource:\n    hikari:\n      maximum-pool-size: 20\n',
});

export function testConfig(): SimulatorConfig {
  return loadConfig({});
}
