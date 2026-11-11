/**
 * Correlation engine across alerts, log spikes, dependency graphs, and recent changes.
 */
export interface CorrelationCandidate {
  appTla: string;
  confidence: number;
  reasons: string[];
}
