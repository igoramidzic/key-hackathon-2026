/**
 * Incident agent entry point.
 *
 *   pnpm agent            start the watchers and the orchestrator
 *   pnpm agent --check    connectivity check, then exit
 *   pnpm agent cases      list cases with phase and links
 *   pnpm agent case <id>  print one case's timeline
 */

import { printCase, printCases } from './cases/cli';
import { CaseStore } from './cases/store';
import { printChecks, runChecks } from './check';
import { ConfigError, loadConfig } from './config';
import { logger, setLogLevel } from './log';

const USAGE = `Usage: pnpm agent [command]

Commands:
  (none)        Watch the world and run the incident process
  --check       Check connectivity to the four MCP servers and the live feeds, then exit
  cases         List cases with their phase and links
  case <id>     Print a case's timeline (id prefix or incident number)
  help          Show this help

Env: SIM_PUBLIC_URL (hosted world), AGENT_LLM (auto|claude|off), ANTHROPIC_API_KEY,
     AGENT_DRY_RUN, AGENT_AUTO_RESOLVE, AGENT_SPEED. See apps/incident-agent/README.md.`;

async function main(argv: string[]): Promise<number> {
  const command = argv[0] ?? 'run';
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return 0;
  }
  const config = loadConfig();
  setLogLevel(config.logLevel);

  switch (command) {
    case '--check':
    case 'check':
      return printChecks(await runChecks(config), config) ? 0 : 1;
    case 'cases':
      printCases(new CaseStore(config.dataDir));
      return 0;
    case 'case':
      if (!argv[1]) {
        console.error('Usage: pnpm agent case <id>');
        return 2;
      }
      return printCase(new CaseStore(config.dataDir), argv[1]) ? 0 : 1;
    case 'run': {
      const ok = printChecks(await runChecks(config), config);
      if (!ok) return 1;
      logger('agent').info('No orchestrator yet; exiting.');
      return 0;
    }
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof ConfigError) console.error(err.message);
    else console.error(err);
    process.exit(1);
  },
);
