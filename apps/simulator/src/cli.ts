import { ApiError, URLS } from '@sim/contracts';
import {
  createSimulatorClient,
  type RunStatus,
  type SimulatorStatus,
} from '@sim/contracts/simulator';

const BASE = (
  process.env.SIMULATOR_URL ??
  process.env.SIMULATOR_API_URL ??
  URLS.simulator.api
).replace(/\/+$/, '');
const client = createSimulatorClient(BASE);

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  bold: paint(1),
  dim: paint(2),
  red: paint(31),
  green: paint(32),
  yellow: paint(33),
  blue: paint(34),
  cyan: paint(36),
};

const USAGE = `Usage: pnpm sim <command>

Commands:
  list                              List scenarios
  trigger <id> [--speed N] [--force] Start a scenario (speed divides every offset)
  status [--json]                   Engine, systems, traffic and the current run
  stop                              Stop the active run (systems are not reset)
  reset                             Stop the run, reset all systems, backfill traffic
  traffic [--pause|--resume] [--rate N]  Pause/resume baseline traffic or scale it

Env: SIMULATOR_URL (default ${URLS.simulator.api})`;

function flag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function option(args: string[], name: string): string | undefined {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const a = args[i]!;
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[i + 1];
}

function duration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

const PHASE_COLOR: Record<RunStatus['phase'], (s: string) => string> = {
  pending: c.yellow,
  degrading: c.red,
  recovering: c.cyan,
  recovered: c.green,
  stopped: c.dim,
  failed: c.red,
};

function printRun(run: RunStatus): void {
  const phase = PHASE_COLOR[run.phase](run.phase);
  console.log(
    `${c.bold('Run')}      ${run.id} ${c.dim(`"${run.title}"`)}  ${phase}  ${duration(run.elapsed_sec)}  ${run.speed}x`,
  );
  if (run.error) console.log(`         ${c.red(run.error)}`);
  if (run.bad_mr)
    console.log(`         bad MR   ${run.bad_mr.web_url} ${c.dim(`(${run.bad_mr.short_sha})`)}`);
  if (run.fix_mr) console.log(`         fix      ${run.fix_mr.web_url}`);
  for (const inc of run.helpdesk) console.log(`         ${inc.number.padEnd(8)} ${inc.web_url}`);
  const open = run.alerts.filter((a) => !a.resolved).length;
  if (run.alerts.length > 0) {
    console.log(`         alerts   ${run.alerts.length} raised, ${open} open`);
  }
  console.log(`         logs     ${run.logs_url}`);
  if (run.events.length > 0) {
    console.log(c.bold('Events'));
    for (const e of run.events) {
      const kind = e.kind === 'error' ? c.red(e.kind.padEnd(11)) : c.cyan(e.kind.padEnd(11));
      console.log(
        `  ${c.dim(`+${e.offset_sec.toFixed(1)}s`.padStart(8))}  ${kind} ${e.message}${e.url ? c.dim(`  ${e.url}`) : ''}`,
      );
    }
  }
}

function printStatus(s: SimulatorStatus): void {
  const t = s.traffic;
  const engine = s.engine.phase === 'running' ? c.green(s.engine.phase) : c.yellow(s.engine.phase);
  console.log(
    `${c.bold('Engine')}   ${engine}${s.engine.message ? c.dim(` (${s.engine.message})`) : ''}  ` +
      `${t.paused ? c.yellow('traffic paused') : `${t.lines_per_sec} lines/s`}` +
      `${t.rate_multiplier !== 1 ? ` x${t.rate_multiplier}` : ''}  ${t.total_lines.toLocaleString('en-US')} lines` +
      `  noise: ${t.noise_merges} changes, ${t.background_alerts} alerts` +
      (t.ingest_errors > 0 ? c.red(`  ingest errors: ${t.ingest_errors}`) : '') +
      (t.buffered > 50 ? c.yellow(`  buffered: ${t.buffered}`) : ''),
  );
  const dot = (ok: boolean) => (ok ? c.green('ok') : c.red('down'));
  const systems = s.systems
    .map((sys) => `${c.bold(sys.name)} api ${dot(sys.api.ok)} mcp ${dot(sys.mcp.ok)}`)
    .join('   ');
  console.log(`${c.bold('Systems')}  ${systems}`);
  if (s.run) printRun(s.run);
  else console.log(`${c.bold('Run')}      ${c.dim('none')}`);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2).filter((a) => a !== '--');
  switch (cmd) {
    case 'list': {
      const list = await client.listScenarios();
      if (list.length === 0) {
        console.log('No scenarios defined (packages/scenarios).');
        return;
      }
      const w = Math.max(2, ...list.map((s) => s.id.length));
      console.log(c.dim(`${'ID'.padEnd(w)}  ${'KIND'.padEnd(10)}  TITLE`));
      for (const s of list)
        console.log(`${c.bold(s.id.padEnd(w))}  ${s.kind.padEnd(10)}  ${s.title}`);
      return;
    }
    case 'trigger': {
      const id = args.find((a) => !a.startsWith('--') && a !== option(args, 'speed'));
      if (!id) throw new Error('Usage: pnpm sim trigger <id> [--speed N] [--force]');
      const speedArg = option(args, 'speed');
      const speed = speedArg === undefined ? undefined : Number(speedArg);
      if (speed !== undefined && !Number.isFinite(speed))
        throw new Error(`Invalid --speed: ${speedArg}`);
      const run = await client.trigger(id, { speed, force: flag(args, 'force') });
      console.log(`Triggered ${c.bold(run.id)} at ${run.speed}x ${c.dim(`(${run.phase})`)}`);
      printRun(run);
      console.log(c.dim('Follow along with: pnpm sim status'));
      return;
    }
    case 'status': {
      const s = await client.status();
      if (flag(args, 'json')) console.log(JSON.stringify(s, null, 2));
      else printStatus(s);
      return;
    }
    case 'stop': {
      const { run } = await client.stop();
      if (!run) console.log('No run to stop.');
      else
        console.log(
          `${run.id}: ${PHASE_COLOR[run.phase](run.phase)} after ${duration(run.elapsed_sec)}`,
        );
      return;
    }
    case 'reset': {
      process.stdout.write('Resetting systems and backfilling traffic... ');
      const res = await client.reset();
      console.log(
        res.ok ? c.green('done') : c.yellow('done with errors'),
        c.dim(`(${(res.duration_ms / 1000).toFixed(1)}s)`),
      );
      for (const s of res.systems) {
        console.log(
          `  ${s.name.padEnd(11)} ${s.ok ? c.green('reset') : c.red(`failed: ${s.error}`)}`,
        );
      }
      console.log(`  backfilled ${res.backfilled_lines.toLocaleString('en-US')} log lines`);
      return;
    }
    case 'traffic': {
      const rate = option(args, 'rate');
      const t = await client.setTraffic({
        paused: flag(args, 'pause') ? true : flag(args, 'resume') ? false : undefined,
        rate_multiplier: rate === undefined ? undefined : Number(rate),
      });
      console.log(
        `Traffic ${t.paused ? 'paused' : 'running'} at ${t.rate_multiplier}x (${t.lines_per_sec} lines/s)`,
      );
      return;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  if (err instanceof ApiError) {
    console.error(c.red(`Error ${err.status}: ${err.message}`));
  } else if (err instanceof TypeError && /fetch failed/.test(err.message)) {
    console.error(c.red(`Simulator not reachable at ${BASE} (start it with pnpm dev).`));
  } else {
    console.error(c.red(err instanceof Error ? err.message : String(err)));
  }
  process.exitCode = 1;
});
