/**
 * Scenario evaluation harness (#26): runs the agent against each scenario unattended, plays the
 * human who clicks Merge, and scores the result against the answer key. Like the rest of eval/,
 * it may use the simulator API; the agent (src/) may not.
 *
 *   pnpm agent:eval                                       # all five scenarios at 4x
 *   pnpm agent:eval --scenario crd-pool-exhaustion        # one (repeat or comma-separate for more)
 *   pnpm agent:eval --speed 4 --timeout 20 --baseline 15 --verbose
 *
 * Per scenario: reset the world → start the agent (`node --import tsx src/index.ts`) with a fresh
 * AGENT_DATA_DIR, AGENT_SPEED and AGENT_AUTO_RESOLVE=true → let it learn the baseline → trigger →
 * merge the agent's fix MR through GitLab REST as dwhitfield → wait for `recovered` or the timeout
 * → stop the agent → score → reset. Needs `pnpm dev` (or SIM_PUBLIC_URL) and takes over the shared
 * world: don't run it while someone else is using it.
 *
 * Output: apps/incident-agent/.data/eval/<run-id>.md and .json, plus one folder per scenario
 * (<run-id>/<scenario>/) holding the agent's cases and agent.log. Exit code 0 when every scenario
 * passed every check.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { URLS } from '@sim/contracts';
import { createGitlabClient, type GitlabClient } from '@sim/contracts/gitlab';
import { createServiceNowClient, type ServiceNowClient } from '@sim/contracts/servicenow';
import {
  createSimulatorClient,
  type RunStatus,
  type ScenarioDetail,
  type SimulatorClient,
} from '@sim/contracts/simulator';
import { createTeamsClient, type TeamsClient } from '@sim/contracts/teams';
import { CaseStore } from '../src/cases/store';
import { type Case, isTerminal } from '../src/cases/types';
import { type AgentConfig, loadConfig } from '../src/config';
import { loadDotEnv } from '../src/env';
import { color } from '../src/log';
import { pingClaude } from '../src/phases/claude';
import {
  type HumanMerge,
  type Observed,
  pickCase,
  renderScorecard,
  type ScenarioScore,
  type ScorecardMeta,
  sameMr,
  scoreScenario,
} from './score';

const SCENARIOS = [
  'crd-pool-exhaustion',
  'tlr-business-date-helpdesk',
  'ath-token-ttl-cascade',
  'aba-checksum-cascade',
  'cif-snake-case-cascade',
] as const;

const USAGE = `Usage: pnpm agent:eval [--scenario <id>[,<id>…]] [--speed <n>] [--timeout <min>]
                       [--baseline <sec>] [--verbose] [--deterministic]

  --scenario  scenario id(s); default all five: ${SCENARIOS.join(', ')}
  --speed     scenario speed, also passed to the agent as AGENT_SPEED (default 4)
  --timeout   minutes per scenario from the trigger to recovery (default 20)
  --baseline  seconds the agent watches the world before the trigger (default 15)
  --verbose   echo the agent's output (it is always written to agent.log)
  --deterministic  run the agent without a model (AGENT_LLM=off); default is AI phases with Claude

Resets the shared world before and after every scenario.`;

/** The human reviewer who clicks Merge (as in scripts/e2e.ts). */
const HUMAN = 'dwhitfield';
const POLL_MS = 3_000;
const STOP_GRACE_MS = 10_000;
const MAX_MERGE_TRIES = 5;

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PACKAGE_DIR, '../..');
const AGENT_ENTRY = path.join(PACKAGE_DIR, 'src', 'index.ts');
const EVAL_DIR = path.join(PACKAGE_DIR, '.data', 'eval');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rel = (p: string) => path.relative(REPO_ROOT, p);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Options {
  scenarios: string[];
  speed: number;
  timeoutMin: number;
  baselineSec: number;
  verbose: boolean;
}

function parseArgs(argv: string[]): Options {
  const values = (name: string) =>
    argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? [argv[i + 1]!] : []));
  const number = (name: string, fallback: number, min: number) => {
    const raw = values(name).at(-1);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min) throw new Error(`--${name} expects a number >= ${min}`);
    return n;
  };
  const scenarios = values('scenario').flatMap((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return {
    scenarios: scenarios.length ? [...new Set(scenarios)] : [...SCENARIOS],
    speed: number('speed', 4, 0.1),
    timeoutMin: number('timeout', 20, 1),
    baselineSec: number('baseline', 15, 0),
    verbose: argv.includes('--verbose'),
  };
}

// ---------------------------------------------------------------------------
// The agent as a child process
// ---------------------------------------------------------------------------

interface AgentProcess {
  pid: number | undefined;
  exit: { code: number | null; signal: string | null; error?: string } | null;
  exited: Promise<void>;
  /** Signals the agent's whole process group (it may have spawned its own children). */
  kill(signal: NodeJS.Signals): void;
  /** SIGTERM, then SIGKILL after a grace period. Idempotent. */
  stop(): Promise<void>;
}

function describeExit(exit: NonNullable<AgentProcess['exit']>): string {
  if (exit.error) return exit.error;
  return exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`;
}

function startAgent(dataDir: string, speed: number, verbose: boolean): AgentProcess {
  const out = createWriteStream(path.join(dataDir, 'agent.log'), { flags: 'a' });
  const overrides = {
    AGENT_DATA_DIR: dataDir,
    AGENT_SPEED: String(speed),
    AGENT_AUTO_RESOLVE: 'true',
    // A random port, so the live timeline never clashes with an agent you run yourself.
    AGENT_TIMELINE_PORT: '0',
  };
  out.write(
    `# ${new Date().toISOString()} node --import tsx ${rel(AGENT_ENTRY)} ` +
      `${Object.entries(overrides)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')}\n`,
  );
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', AGENT_ENTRY], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so stopping it also stops whatever it spawned.
    detached: true,
  });
  for (const [stream, echo] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ] as const) {
    stream?.pipe(out, { end: false });
    if (verbose) stream?.pipe(echo, { end: false });
  }

  let stopping: Promise<void> | null = null;
  const proc: AgentProcess = {
    pid: child.pid,
    exit: null,
    exited: Promise.resolve(),
    kill: (signal) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        child.kill(signal);
      }
    },
    stop: () => {
      stopping ??= (async () => {
        if (!proc.exit) {
          proc.kill('SIGTERM');
          const done = await Promise.race([
            proc.exited.then(() => true),
            sleep(STOP_GRACE_MS).then(() => false),
          ]);
          if (!done) {
            proc.kill('SIGKILL');
            await proc.exited;
          }
        }
        await new Promise<void>((resolve) => out.end(resolve));
      })();
      return stopping;
    },
  };
  proc.exited = new Promise<void>((resolve) => {
    // 'close' fires once stdout/stderr are drained, so agent.log is complete.
    child.once('close', (code, signal) => {
      proc.exit ??= { code, signal };
      resolve();
    });
    child.once('error', (err) => {
      proc.exit ??= { code: null, signal: null, error: err.message };
      resolve();
    });
  });
  return proc;
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

interface Clients {
  sim: SimulatorClient;
  gitlab: GitlabClient;
  snow: ServiceNowClient;
  teams: TeamsClient;
}

type Say = (msg: string) => void;

async function resetWorld(sim: SimulatorClient, say: Say): Promise<void> {
  say('resetting the world…');
  const res = await sim.reset();
  const bad = res.systems.filter((s) => !s.ok);
  if (!res.ok || bad.length)
    throw new Error(`reset failed: ${bad.map((s) => `${s.name} (${s.error})`).join(', ')}`);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const status = await sim.status().catch(() => null);
    if (status?.engine.phase === 'running') return;
    await sleep(1000);
  }
  throw new Error('the simulator engine was not running 2 min after the reset');
}

/** This trigger's run, or null when the status shows another (or no) run. */
async function currentRun(sim: SimulatorClient, startedAt: string): Promise<RunStatus | null> {
  const run = (await sim.status()).run;
  return run && run.started_at === startedAt ? run : null;
}

function loadCases(dataDir: string): Case[] {
  try {
    return new CaseStore(dataDir).load();
  } catch {
    return [];
  }
}

/** Merges every fix MR the agent opened, like a human clicking Merge in the GitLab UI. */
async function humanMerges(
  cases: Case[],
  merges: HumanMerge[],
  failures: Map<string, number>,
  gitlab: GitlabClient,
  say: Say,
): Promise<void> {
  for (const c of cases) {
    const mr = c.fix_mr;
    if (!mr || merges.some((m) => sameMr(m, mr))) continue;
    const key = `${mr.project}!${mr.iid}`;
    const tries = failures.get(key) ?? 0;
    if (tries >= MAX_MERGE_TRIES) continue;
    try {
      const current = await gitlab.getMergeRequest(mr.project, mr.iid);
      if (current.state === 'closed') continue;
      const base = {
        project: mr.project,
        iid: mr.iid,
        web_url: mr.web_url,
        opened_at: current.created_at,
        case_id: c.id,
      };
      if (current.state === 'merged') {
        const by = current.merged_by?.username ?? 'unknown';
        merges.push({
          ...base,
          merged_at: current.merged_at ?? new Date().toISOString(),
          merged_by: by,
        });
        say(color.yellow(`${key} was already merged by ${by}`));
        continue;
      }
      const merged = await gitlab.mergeMergeRequest(mr.project, mr.iid, { merged_by: HUMAN });
      merges.push({
        ...base,
        merged_at: merged.merged_at ?? new Date().toISOString(),
        merged_by: HUMAN,
      });
      say(color.green(`merged ${key} as ${HUMAN} (the human clicking Merge)`));
    } catch (err) {
      failures.set(key, tries + 1);
      say(color.yellow(`merging ${key} failed (${tries + 1}/${MAX_MERGE_TRIES}): ${message(err)}`));
    }
  }
}

/** Looks up what the score needs from the world: on-call, channel members, child incidents. */
async function observe(
  detail: ScenarioDetail,
  run: RunStatus | null,
  cases: Case[],
  merges: HumanMerge[],
  clients: Clients,
): Promise<Observed> {
  const quiet = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch {
      return null;
    }
  };
  const c = pickCase(cases, run, detail);
  const app = await quiet(() => clients.snow.getApp(detail.answer_key.culprit_tla));
  const channelId = c?.channel?.id;
  const channel = channelId ? await quiet(() => clients.teams.getChannel(channelId)) : null;
  const number = c?.incident?.number;
  const incident = number ? await quiet(() => clients.snow.getIncident(number)) : null;
  return {
    merges,
    culpritOnCall: app
      ? {
          group: app.support_group.name,
          primary: app.support_group.on_call?.primary?.username ?? null,
          secondary: app.support_group.on_call?.secondary?.username ?? null,
        }
      : null,
    channelMembers: channel ? channel.members.map((m) => m.username) : null,
    incidentChildren: incident ? (incident.child_incidents ?? []).map((i) => i.number) : null,
  };
}

// ---------------------------------------------------------------------------
// One scenario
// ---------------------------------------------------------------------------

interface Context {
  opts: Options;
  config: AgentConfig;
  clients: Clients;
  runDir: string;
  setActive(agent: AgentProcess | null): void;
}

/** Polls until recovery (plus a grace period for the agent to wrap up), a dead end or timeout. */
async function watchRun(
  detail: ScenarioDetail,
  triggered: RunStatus,
  agent: AgentProcess,
  dataDir: string,
  merges: HumanMerge[],
  ctx: Context,
  say: Say,
): Promise<{ run: RunStatus; error: string | null }> {
  const deadline = Date.now() + ctx.opts.timeoutMin * 60_000;
  // After recovery the agent verifies for a healthy window, then resolves: give it that long.
  const graceMs = (ctx.config.verify.healthySec + 30) * 1000;
  const phases = new Map<string, string>();
  const failures = new Map<string, number>();
  let run = triggered;
  let recoveredSeen: number | null = null;
  for (;;) {
    const cases = loadCases(dataDir);
    for (const c of cases) {
      if (phases.get(c.id) === c.phase) continue;
      phases.set(c.id, c.phase);
      const what = [c.incident?.number, c.apps.join(',')].filter(Boolean).join(' ');
      say(`case ${c.id.slice(-8)} → ${c.phase}${what ? color.dim(` (${what})`) : ''}`);
    }
    await humanMerges(cases, merges, failures, ctx.clients.gitlab, say);

    const latest = await currentRun(ctx.clients.sim, triggered.started_at).catch(() => null);
    if (latest) {
      if (latest.phase !== run.phase) say(color.bold(`run ${latest.phase}`));
      run = latest;
    }
    if (agent.exit) return { run, error: `agent exited (${describeExit(agent.exit)})` };
    if (run.phase === 'recovered') {
      recoveredSeen ??= Date.now();
      const c = pickCase(cases, run, detail);
      if ((c && isTerminal(c.phase)) || Date.now() - recoveredSeen >= graceMs)
        return { run, error: null };
    } else if (run.phase === 'stopped' || run.phase === 'failed') {
      return { run, error: `run ${run.phase}${run.error ? `: ${run.error}` : ''}` };
    } else if (Date.now() > deadline) {
      return { run, error: `timed out after ${ctx.opts.timeoutMin} min (run ${run.phase})` };
    }
    await sleep(POLL_MS);
  }
}

async function runScenario(detail: ScenarioDetail, ctx: Context): Promise<ScenarioScore> {
  const t0 = Date.now();
  const say: Say = (msg) => {
    const s = Math.round((Date.now() - t0) / 1000);
    console.log(
      `  ${color.dim(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`)} ${msg}`,
    );
  };
  const dataDir = path.join(ctx.runDir, detail.id);
  mkdirSync(dataDir, { recursive: true });
  const artifacts = { data_dir: rel(dataDir), agent_log: rel(path.join(dataDir, 'agent.log')) };
  const merges: HumanMerge[] = [];
  let run: RunStatus | null = null;
  let error: string | null = null;

  const agent = startAgent(dataDir, ctx.opts.speed, ctx.opts.verbose);
  ctx.setActive(agent);
  try {
    say(`agent started (pid ${agent.pid}); learning the baseline for ${ctx.opts.baselineSec}s`);
    await Promise.race([agent.exited, sleep(ctx.opts.baselineSec * 1000)]);
    if (agent.exit) throw new Error(`agent exited during startup (${describeExit(agent.exit)})`);
    const triggered = await ctx.clients.sim.trigger(detail.id, { speed: ctx.opts.speed });
    run = triggered;
    say(`triggered ${detail.id} at ${ctx.opts.speed}x`);
    if (triggered.phase === 'failed')
      throw new Error(`trigger failed: ${triggered.error ?? 'unknown error'}`);
    const watched = await watchRun(detail, triggered, agent, dataDir, merges, ctx, say);
    run = watched.run;
    error = watched.error;
  } catch (err) {
    error = message(err);
  } finally {
    say('stopping the agent');
    await agent.stop();
    ctx.setActive(null);
  }
  if (error) say(color.red(error));

  const cases = loadCases(dataDir);
  const observed = await observe(detail, run, cases, merges, ctx.clients);
  const score = scoreScenario({ scenario: detail, run, cases, observed, error, artifacts });
  say(
    `${score.ok ? color.green('PASS') : color.red('FAIL')} ${score.passed}/${score.applicable} checks`,
  );
  return score;
}

// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const opts = parseArgs(argv);
  loadDotEnv();
  if (argv.includes('--deterministic')) process.env.AGENT_LLM = 'off';
  const config = loadConfig({ ...process.env, AGENT_SPEED: String(opts.speed) });
  if (config.llm.mode === 'claude') {
    // Fail before touching the world: an agent without a model would only fail the scenarios.
    const ping = await pingClaude(config.llm.model);
    if (!ping.ok) {
      console.error(
        `Claude is not reachable (${ping.detail}).\nRun \`claude auth login\`, put ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in apps/incident-agent/.env, or pass --deterministic.`,
      );
      return 2;
    }
  }
  const clients: Clients = {
    sim: createSimulatorClient(process.env.SIMULATOR_URL ?? URLS.simulator.api),
    gitlab: createGitlabClient(URLS.gitlab.api),
    snow: createServiceNowClient(URLS.servicenow.api),
    teams: createTeamsClient(URLS.teams.api),
  };

  const details: ScenarioDetail[] = [];
  for (const id of opts.scenarios) {
    details.push(
      await clients.sim.getScenario(id).catch((err) => {
        throw new Error(`scenario ${id}: ${message(err)} (is \`pnpm dev\` running?)`);
      }),
    );
  }

  const startedAt = new Date();
  const runId = startedAt
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
    .replace('T', '-');
  const runDir = path.join(EVAL_DIR, runId);
  mkdirSync(runDir, { recursive: true });
  const meta: ScorecardMeta = {
    run_id: runId,
    started_at: startedAt.toISOString(),
    speed: opts.speed,
    timeout_min: opts.timeoutMin,
    llm:
      config.llm.mode === 'claude'
        ? `claude (${config.llm.model} / ${config.llm.deepModel})`
        : 'off (heuristics)',
  };
  const mdFile = path.join(EVAL_DIR, `${runId}.md`);
  const jsonFile = path.join(EVAL_DIR, `${runId}.json`);
  const results: ScenarioScore[] = [];
  const save = () => {
    writeFileSync(mdFile, renderScorecard(results, meta));
    writeFileSync(jsonFile, `${JSON.stringify({ meta, results }, null, 2)}\n`);
  };

  let active: AgentProcess | null = null;
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log(
      color.yellow(
        '\ninterrupted: stopping the agent (again to force). The world is left as it is; `pnpm sim reset` cleans up.',
      ),
    );
    void (active?.stop() ?? Promise.resolve()).finally(() => {
      if (results.length) save();
      process.exit(130);
    });
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  // Never leave an agent running behind us, however the harness exits.
  process.on('exit', () => {
    if (active && !active.exit) active.kill('SIGKILL');
  });

  console.log(
    `${color.bold('Incident agent eval')} ${runId}: ${details.length} scenario(s) at ${opts.speed}x, ` +
      `timeout ${opts.timeoutMin} min, LLM ${meta.llm}`,
  );
  console.log(color.dim(`  output: ${rel(runDir)}`));
  const ctx: Context = {
    opts,
    config,
    clients,
    runDir,
    setActive: (agent) => {
      active = agent;
    },
  };
  const top: Say = (msg) => console.log(`  ${msg}`);
  await resetWorld(clients.sim, top);
  for (const [i, detail] of details.entries()) {
    console.log(
      `\n${color.bold(`[${i + 1}/${details.length}] ${detail.id}`)} ${color.dim(detail.title)}`,
    );
    results.push(await runScenario(detail, ctx));
    save();
    await resetWorld(clients.sim, top);
  }

  console.log(`\n${renderScorecard(results, meta)}`);
  console.log(color.dim(`saved ${rel(mdFile)} and ${rel(jsonFile)}`));
  return results.every((r) => r.ok) ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(color.red(message(err)));
    process.exit(2);
  },
);
