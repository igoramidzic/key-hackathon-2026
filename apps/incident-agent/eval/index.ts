/**
 * Evaluation framework and benchmarks for the incident agent.
 */
export interface EvalRun {
  scenarioId: string;
  durationMs: number;
  success: boolean;
}
