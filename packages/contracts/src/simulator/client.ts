import { createHttp } from '../http';
import type {
  ResetResponse,
  RunStatus,
  ScenarioDetail,
  ScenarioSummary,
  SimulatorStatus,
  StopResponse,
  TrafficInput,
  TrafficStatus,
  TriggerInput,
} from './types';

/** Typed client for the simulator engine. `baseUrl` may be '' in the control panel (Vite proxy). */
export function createSimulatorClient(baseUrl: string) {
  const http = createHttp(baseUrl);
  return {
    http,
    listScenarios: () => http.get<ScenarioSummary[]>('/api/scenarios'),
    getScenario: (id: string) =>
      http.get<ScenarioDetail>(`/api/scenarios/${encodeURIComponent(id)}`),
    trigger: (id: string, body: TriggerInput = {}) =>
      http.post<RunStatus>(`/api/scenarios/${encodeURIComponent(id)}/trigger`, body),
    stop: () => http.post<StopResponse>('/api/stop'),
    reset: () => http.post<ResetResponse>('/api/reset'),
    status: () => http.get<SimulatorStatus>('/api/status'),
    setTraffic: (body: TrafficInput) => http.post<TrafficStatus>('/api/traffic', body),
  };
}

export type SimulatorClient = ReturnType<typeof createSimulatorClient>;
