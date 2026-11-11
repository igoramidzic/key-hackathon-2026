/**
 * Records a scenario run's WARNING+ logs as a detector fixture (eval may use the simulator API;
 * the agent may not). Resets the world, triggers the scenario, waits, records, resets again.
 *
 *   tsx eval/record-scenario.ts --scenario crd-pool-exhaustion --speed 4 --minutes 3
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { URLS } from '@sim/contracts';
import { createSimulatorClient } from '@sim/contracts/simulator';
import { loadConfig } from '../src/config';
import { recordLogs } from './record-logs';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const scenario = flag('scenario');
  if (!scenario) throw new Error('--scenario <id> is required');
  const speed = Number(flag('speed') ?? 4);
  const minutes = Number(flag('minutes') ?? 3);
  const out = flag('out') ?? path.join('test', 'fixtures', `${scenario}-x${speed}.json.gz`);
  const config = loadConfig();
  const sim = createSimulatorClient(process.env.SIMULATOR_URL ?? URLS.simulator.api);

  console.log('resetting the world…');
  await sim.reset();
  for (let i = 0; i < 60; i++) {
    if ((await sim.status()).engine.phase === 'running') break;
    await sleep(1000);
  }
  // Let live background traffic flow for a bit after the backfill.
  await sleep(20_000);
  const before = new Date(Date.now() - 6 * 60_000).toISOString();
  const run = await sim.trigger(scenario, { speed });
  console.log(`triggered ${scenario} at ${speed}x (${run.started_at}); recording for ${minutes}m`);
  await sleep(minutes * 60_000);
  const status = (await sim.status()).run;
  const entries = await recordLogs({ logsApi: config.logsApi, since: before });
  const meta = {
    scenario,
    speed,
    started_at: run.started_at,
    fault_onset_at: status?.fault_onset_at ?? null,
    recorded_at: new Date().toISOString(),
  };
  writeFileSync(out, gzipSync(JSON.stringify({ meta, entries })));
  console.log(`${entries.length} entries written to ${out}`, meta);
  await sim.reset();
  console.log('world reset');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
