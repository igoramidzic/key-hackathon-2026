import { scenarios as defined, type ScenarioDefinition } from '@sim/scenarios';
import { createSimulatorApi } from './api';
import { Engine, type EngineOptions } from './engine';
import { createSystems, loadConfig } from './systems';

export const SERVICE = 'simulator';

export interface SimulatorHostOptions {
  /** Env-style overrides (see loadConfig). Defaults to process.env when available. */
  env?: Record<string, string | undefined>;
  scenarios?: ScenarioDefinition[];
  backfillMinutes?: number;
}

/**
 * The simulator engine and its REST API (no port binding). The caller boots the engine
 * (`engine.boot()`) once the four system APIs are reachable.
 */
export function createSimulator(opts: SimulatorHostOptions = {}) {
  const env =
    opts.env ??
    (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ??
    {};
  const config = loadConfig(env);
  const scenarios = opts.scenarios ?? defined;
  const engineOpts: EngineOptions = {
    config,
    systems: createSystems(config),
    scenarios,
    backfillMinutes: opts.backfillMinutes,
  };
  const engine = new Engine(engineOpts);
  return { app: createSimulatorApi(engine), engine, config, scenarios };
}
