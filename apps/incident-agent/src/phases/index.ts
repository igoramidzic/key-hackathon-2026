/**
 * Incident resolution phases: detect -> scope -> trace -> open -> group -> assemble -> fix -> link -> ship -> verify.
 */
export const INCIDENT_PHASES = [
  'detect',
  'scope',
  'trace',
  'open',
  'group',
  'assemble',
  'fix',
  'link',
  'ship',
  'verify',
] as const;

export type IncidentPhase = (typeof INCIDENT_PHASES)[number];
