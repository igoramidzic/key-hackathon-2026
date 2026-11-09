import { startApi } from '@sim/api-kit/node';
import { scenarios as defined } from '@sim/scenarios';
import { createSimulator, SERVICE } from './host';

// SIM_TEST_SCENARIO=1 adds the unit-test scenario (needs a GitLab seeded for it) for engine checks.
const scenarios = process.env.SIM_TEST_SCENARIO
  ? [...defined, (await import('./test-helpers')).testScenario()]
  : defined;
const { app, engine, config } = createSimulator({ scenarios });

startApi(app, { port: config.port, service: SERVICE });
console.log(
  `[${SERVICE}] ${scenarios.length} scenario(s); systems: ${Object.values(config.systems)
    .map((s) => `${s.name}=${s.api}`)
    .join(' ')}`,
);

engine.boot().catch((err) => {
  console.error(`[${SERVICE}] boot failed`, err);
  process.exitCode = 1;
});
