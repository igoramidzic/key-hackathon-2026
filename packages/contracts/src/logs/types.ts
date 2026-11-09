import type { Page } from '../common';

/**
 * Log entries follow the GCP Cloud Logging LogEntry shape (camelCase), so filters like
 * `resource.labels.container_name="payments-api"` or `jsonPayload.message:"timeout"` read
 * naturally to anyone who has used Logs Explorer.
 */
export const SEVERITIES = [
  'DEFAULT',
  'DEBUG',
  'INFO',
  'NOTICE',
  'WARNING',
  'ERROR',
  'CRITICAL',
  'ALERT',
  'EMERGENCY',
] as const;
export type Severity = (typeof SEVERITIES)[number];

export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

export interface LogResource {
  type: 'k8s_container';
  labels: {
    project_id: string;
    location: string;
    cluster_name: string;
    namespace_name: string;
    pod_name: string;
    container_name: string;
  };
}

export interface LogLabels {
  app_tla: string;
  app_name: string;
  env: 'prod';
  version: string;
  [key: string]: string;
}

export interface LogError {
  type: string;
  message: string;
  stack_trace?: string;
}

export interface LogJsonPayload {
  message: string;
  logger?: string;
  thread?: string;
  error?: LogError;
  [key: string]: unknown;
}

export interface HttpRequestInfo {
  requestMethod: string;
  requestUrl: string;
  status: number;
  /** Duration string, GCP style: "0.142s". */
  latency: string;
  userAgent?: string;
  remoteIp?: string;
}

export interface LogEntry {
  /** Unique id assigned at ingest. */
  insertId: string;
  /**
   * Monotonic sequence number assigned at ingest. Use it as a tail cursor:
   * every entry with seq > N arrived after entry N.
   */
  seq: number;
  /** `projects/<project>/logs/<stream>`, e.g. `projects/kb-prod-cif00/logs/stdout`. */
  logName: string;
  /** When the event happened (ISO 8601). */
  timestamp: string;
  /** When the log backend received it (ISO 8601). */
  receiveTimestamp: string;
  severity: Severity;
  resource: LogResource;
  labels: LogLabels;
  jsonPayload?: LogJsonPayload;
  textPayload?: string;
  httpRequest?: HttpRequestInfo;
  /** `projects/<project>/traces/<traceId>` */
  trace?: string;
  spanId?: string;
}

/** What producers (the simulator) send. The API assigns insertId, seq and receiveTimestamp. */
export type LogEntryInput = Omit<LogEntry, 'insertId' | 'seq' | 'receiveTimestamp'> & {
  insertId?: string;
};

export interface IngestRequest {
  entries: LogEntryInput[];
}

export interface IngestResult {
  accepted: number;
  last_seq: number;
}

/** Message text of an entry regardless of payload type. */
export function logMessage(entry: Pick<LogEntry, 'jsonPayload' | 'textPayload'>): string {
  return entry.jsonPayload?.message ?? entry.textPayload ?? '';
}

// ---------------------------------------------------------------------------
// Moogsoft-style alerts
// ---------------------------------------------------------------------------

export type AlertSeverity = 'critical' | 'major' | 'minor' | 'warning' | 'clear';
export type AlertStatus = 'open' | 'acknowledged' | 'resolved' | 'closed';

/** Monitoring tool that raised the event. */
export type AlertManager =
  | 'AppDynamics'
  | 'GCP Monitoring'
  | 'Prometheus'
  | 'Synthetics'
  | 'Splunk'
  | 'SolarWinds';

export interface AlertNote {
  at: string;
  author: string;
  text: string;
}

export interface Alert {
  /** Numeric alert id, e.g. 48213. */
  id: number;
  severity: AlertSeverity;
  status: AlertStatus;
  /** Human readable summary, e.g. "HTTP 5xx rate 23% on online-banking-bff (threshold 5%)". */
  description: string;
  /** Host, pod or endpoint the event came from. */
  source: string;
  /** Service (container) name, matches log `resource.labels.container_name`. */
  service: string;
  app_tla: string;
  manager: AlertManager;
  /** Alert class, e.g. "Application", "Infrastructure", "Synthetic". */
  class: string;
  /** Metric or check name, e.g. "http_5xx_rate". */
  check: string;
  /** Repeat events with the same key update this alert instead of creating a new one. */
  dedupe_key: string;
  first_event_time: string;
  last_event_time: string;
  event_count: number;
  owner: string | null;
  incident_number: string | null;
  notes: AlertNote[];
  custom_info: Record<string, string | number | boolean>;
  /** Link to the alert in the Moogsoft UI, e.g. `http://localhost:3001/alerts/48213`. */
  web_url: string;
}

/** Body for `POST /api/alerts`. Repeats with an existing open dedupe_key bump event_count. */
export interface AlertInput {
  severity: AlertSeverity;
  description: string;
  source: string;
  service: string;
  app_tla: string;
  manager: AlertManager;
  class: string;
  check: string;
  dedupe_key: string;
  custom_info?: Record<string, string | number | boolean>;
  /** Defaults to now. */
  event_time?: string;
}

/** Body for `PATCH /api/alerts/:id`. */
export interface AlertUpdate {
  status?: AlertStatus;
  severity?: AlertSeverity;
  owner?: string | null;
  incident_number?: string | null;
  /** Appended to notes. */
  note?: { author: string; text: string };
}

/** Query for `GET /api/alerts`. List params are comma-separated (`status=open,acknowledged`). */
export interface AlertListQuery {
  status?: string;
  severity?: string;
  app_tla?: string;
  service?: string;
  /** Substring match on id, description, source, service, check, TLA, owner. */
  q?: string;
  /** Only alerts whose last event is at or after this time (ISO or relative like `24h`). */
  since?: string;
  limit?: number;
  cursor?: string;
}

// ---------------------------------------------------------------------------
// Log queries
// ---------------------------------------------------------------------------

/**
 * Filters shared by every log read endpoint (search, tail, stream, histogram, summary, services).
 * All of them are ANDed together.
 */
export interface LogFilterQuery {
  /**
   * Logging query language (GCP subset), e.g.
   * `severity>=ERROR resource.labels.container_name="payments-api" jsonPayload.message:"timeout"`.
   */
  filter?: string;
  /** Minimum severity, e.g. `WARNING`. */
  severity?: Severity;
  /** One or more TLAs (comma-separated or array), e.g. `PAY,ACH`. */
  app_tla?: string | string[];
  /** One or more services (k8s container names), e.g. `payments-api`. */
  service?: string | string[];
  /** Free-text, case-insensitive substring across message, payload, URL and labels. */
  q?: string;
  /** Start of the time window: ISO 8601 or relative (`15m`, `2h`, `7d`). */
  since?: string;
  /** End of the time window: ISO 8601 or relative. Defaults to now. */
  until?: string;
}

/** Query for `GET /api/logs`. */
export interface LogSearchQuery extends LogFilterQuery {
  /** Only entries with seq greater than this (disables the default 1h window). */
  after_seq?: number;
  /** By timestamp. Default `desc` (newest first). */
  order?: 'asc' | 'desc';
  /** 1-500, default 50. */
  limit?: number;
  cursor?: string;
}

/** `GET /api/logs` result: a page of entries plus the newest seq in the store (stream cursor). */
export interface LogSearchResult extends Page<LogEntry> {
  total: number;
  last_seq: number;
}

/** Query for `GET /api/logs/tail` (arrival order, optional long-poll). */
export interface LogTailQuery extends LogFilterQuery {
  /** Return entries with seq > after_seq. Omit to get the latest `limit` entries. */
  after_seq?: number;
  /** When nothing new matches yet, wait up to this many seconds (0-30) for new entries. */
  wait_seconds?: number;
  /** 1-500, default 50. */
  limit?: number;
}

export interface LogTailResult {
  /** Matching entries in arrival (seq) order. */
  items: LogEntry[];
  /** Pass as `after_seq` on the next call. */
  cursor: number;
  last_seq: number;
  /** True when more matching entries are already available after `cursor`. */
  has_more: boolean;
}

/** Query for `GET /api/logs/stream` (Server-Sent Events). */
export interface LogStreamQuery extends LogFilterQuery {
  /** Replay matching entries with seq > after_seq first. `Last-Event-ID` takes precedence. */
  after_seq?: number;
}

export interface LogHistogramBucket {
  /** Bucket start (ISO 8601). */
  start: string;
  total: number;
  counts: Partial<Record<Severity, number>>;
}

export interface LogHistogram {
  since: string;
  until: string;
  bucket_seconds: number;
  total: number;
  buckets: LogHistogramBucket[];
}

/** Query for `GET /api/logs/summary`. Defaults: severity WARNING, since 30m. */
export interface LogSummaryQuery extends LogFilterQuery {
  /** Max fingerprints (1-200, default 50). */
  limit?: number;
}

/** A group of similar log lines (same app, service and normalized message). */
export interface ErrorFingerprint {
  app_tla: string;
  service: string;
  /** Highest severity seen in the group. */
  severity: Severity;
  /** Short stable hash of app + service + pattern. */
  fingerprint: string;
  /** Normalized message: numbers, ids, amounts and quoted values replaced by placeholders. */
  pattern: string;
  count: number;
  first_seen: string;
  last_seen: string;
  sample_message: string;
  sample_insert_id: string;
  /** `jsonPayload.error.type` of the sample, when present. */
  error_type?: string;
  /** Most common HTTP status in the group, when entries carry `httpRequest`. */
  http_status?: number;
}

export interface LogSummary {
  since: string;
  until: string;
  /** Entries that matched the filters (before grouping). */
  total_matched: number;
  items: ErrorFingerprint[];
}

export interface LogServiceStats {
  service: string;
  app_tla: string;
  app_name: string;
  total: number;
  counts: Partial<Record<Severity, number>>;
  /** Entries with severity >= ERROR. */
  errors: number;
  /** Entries with severity WARNING. */
  warnings: number;
  /** errors / total, 0-1. */
  error_rate: number;
  last_seen: string;
  last_error_at: string | null;
}

export interface LogServicesResult {
  since: string;
  until: string;
  items: LogServiceStats[];
}
