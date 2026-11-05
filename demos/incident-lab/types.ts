export type ScenarioKey = 'db-pool' | 'bad-deploy' | 'latency';
export type Phase =
  'healthy' | 'injecting' | 'detected' | 'enriching' | 'collaborating' | 'analyzing' | 'resolved';
export interface Participant {
  name: string;
  role: string;
  initials: string;
}
export interface AppRecord {
  id: string;
  slug: string;
  name: string;
  displayName: string;
  team: string;
  tier: string;
  region: string;
  environment: string;
  status: 'healthy' | 'degraded' | 'critical';
  owner: string;
  onCall: string;
  runtime: string;
  version: string;
  cluster: string;
  project: string;
  namespace: string;
  dependencies: string[];
  repo: string;
  serviceNowId: string;
}
export interface LogEntry {
  id: string;
  timestamp: string;
  source: 'gcp' | 'kibana' | 'moogsoft';
  severity: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  appId: string;
  message: string;
  traceId: string;
  metadata: Record<string, unknown>;
}
export interface Incident {
  id: string;
  title: string;
  appId: string;
  severity: 'P1';
  status: string;
  createdAt: string;
  resolvedAt?: string;
  summary: string;
  hypothesis: string;
  team: string;
  participants: Participant[];
  evidence: string[];
  timeline: { time: string; title: string; detail: string }[];
  runbookId: string;
  changeId: string;
}
export interface ChatMessage {
  id: string;
  author: string;
  role: 'agent' | 'human' | 'system';
  text: string;
  timestamp: string;
  links?: { label: string; href: string }[];
  kind?: 'analysis' | 'summary';
}
export interface SimulationEvent {
  id: string;
  time: string;
  title: string;
  detail: string;
  type: string;
}
export interface SimulationControls {
  running: boolean;
  speed: number;
  phase: Phase;
  elapsed: number;
  scenario: ScenarioKey;
  targetAppId: string;
  incidentElapsed?: number;
}
export interface SimulationState {
  apps: AppRecord[];
  logs: LogEntry[];
  incidents: Incident[];
  messages: ChatMessage[];
  events: SimulationEvent[];
  simulation: SimulationControls;
  stats: {
    logsPerSecond: number;
    errorRate: number;
    healthyApps: number;
    totalApps: number;
    totalLogs: number;
  };
  generation: number;
}
export interface ControlInput {
  action: 'start' | 'pause' | 'reset' | 'inject' | 'resolve' | 'speed';
  speed?: number;
  scenario?: ScenarioKey;
  appId?: string;
}

export type AppState = SimulationState;
export interface ViewApi {
  navigate(path: string): void;
  control(input: ControlInput): Promise<void>;
  toast(text: string): void;
  escape(text: unknown): string;
  refresh(): Promise<void>;
  sendMessage(text: string): Promise<void>;
}
