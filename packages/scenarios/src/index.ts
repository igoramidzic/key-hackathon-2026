export * from './types';

import { overlays } from './repos';
import { abaChecksumCascade } from './scenarios/aba-checksum-cascade';
import { athTokenTtlCascade } from './scenarios/ath-token-ttl-cascade';
import { cifSnakeCaseCascade } from './scenarios/cif-snake-case-cascade';
import { crdPoolExhaustion } from './scenarios/crd-pool-exhaustion';
import { tlrBusinessDateHelpdesk } from './scenarios/tlr-business-date-helpdesk';
import type { RepoOverlay, ScenarioDefinition } from './types';

/**
 * Hand-written code for hero repos, keyed by repo path (`keybank/CIF00/customer-profile-api`).
 * The GitLab API seeds every repo from its generated template, then applies the overlay (see
 * `RepoOverlay`). Seeded history never edits overlay files, so scenario find/replace edits apply.
 */
export const heroRepoOverlays: Record<string, RepoOverlay> = overlays;

/** All scenarios, in control-panel order. */
export const scenarios: ScenarioDefinition[] = [
  cifSnakeCaseCascade,
  athTokenTtlCascade,
  abaChecksumCascade,
  crdPoolExhaustion,
  tlrBusinessDateHelpdesk,
];

export function getScenario(id: string): ScenarioDefinition | undefined {
  return scenarios.find((s) => s.id === id);
}
