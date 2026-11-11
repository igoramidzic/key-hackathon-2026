/**
 * One command for the guided demo. With the world up (`pnpm dev`):
 *
 *   pnpm demo                    # start the incident agent at 4x and open the guided demo page
 *   pnpm demo --speed 2          # slower scenario (the page reads the speed from the agent)
 *   pnpm demo --deterministic    # no model: the agent's deterministic heuristics
 *   pnpm demo --no-open          # don't open the browser
 *
 * The page (control panel → /demo) resets the world, triggers the scenario and follows the agent's
 * case live, so this only has to make sure the agent is running with a matching speed.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { URLS } from '../packages/contracts/src/config';
import { createSimulatorClient } from '../packages/contracts/src/simulator/client';

const argv = process.argv.slice(2);
const flag = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const SPEED = Number(flag('--speed') ?? 4);
const OPEN = !argv.includes('--no-open');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = `${URLS.simulator.web}/demo`;

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true })
    .on('error', () => console.log(`Open ${url} in a browser.`))
    .unref();
}

async function main(): Promise<number> {
  if (!Number.isFinite(SPEED) || SPEED <= 0) {
    console.error('--speed must be a positive number');
    return 2;
  }
  try {
    const status = await createSimulatorClient(URLS.simulator.api).status();
    const down = status.systems.filter((s) => !s.api.ok || !s.mcp.ok).map((s) => s.label);
    if (down.length) console.warn(`Still starting: ${down.join(', ')}. The page waits for them.`);
  } catch {
    console.error(`The simulated world is not running (${URLS.simulator.api}).`);
    console.error('Start it in another terminal first:  pnpm dev');
    return 1;
  }

  console.log(`Guided demo: ${PAGE}`);
  console.log(`Starting the incident agent at ${SPEED}x. Ctrl+C stops it.\n`);
  const agent = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      path.join(ROOT, 'apps/incident-agent/src/index.ts'),
      ...(argv.includes('--deterministic') ? ['--deterministic'] : []),
    ],
    {
      cwd: ROOT,
      stdio: 'inherit',
      // The agent closes the incident itself once recovery is confirmed, so the demo's only
      // human step is the merge.
      env: { AGENT_AUTO_RESOLVE: 'true', ...process.env, AGENT_SPEED: String(SPEED) },
    },
  );
  if (OPEN) setTimeout(() => openBrowser(PAGE), 2_500);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => agent.kill(signal));
  return new Promise((resolve) => agent.on('exit', (code) => resolve(code ?? 0)));
}

main().then((code) => process.exit(code));
