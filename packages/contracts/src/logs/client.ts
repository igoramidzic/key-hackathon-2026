import type { Health, Page, ResetResult } from '../common';
import { createHttp, type QueryValue, toQuery } from '../http';
import type {
  Alert,
  AlertInput,
  AlertListQuery,
  AlertUpdate,
  IngestRequest,
  IngestResult,
  LogEntry,
  LogFilterQuery,
  LogHistogram,
  LogSearchQuery,
  LogSearchResult,
  LogServicesResult,
  LogStreamQuery,
  LogSummary,
  LogSummaryQuery,
  LogTailQuery,
  LogTailResult,
} from './types';

const q = (query: object = {}) => query as Record<string, QueryValue>;

/**
 * Typed client for the Logs API (Cloud Logging + Moogsoft alerts).
 * Owned by the logs system; the methods below are relied on by the simulator and must keep
 * their signatures. Add query methods freely.
 */
export function createLogsClient(baseUrl: string) {
  const http = createHttp(baseUrl);
  return {
    http,
    health: () => http.get<Health>('/health'),
    reset: () => http.post<ResetResult>('/admin/reset'),

    /** `POST /api/logs/ingest` */
    ingest: (body: IngestRequest) => http.post<IngestResult>('/api/logs/ingest', body),

    /** `GET /api/logs`: filtered, time-ordered page of entries (default: last 1h, newest first). */
    search: (query: LogSearchQuery = {}) => http.get<LogSearchResult>('/api/logs', q(query)),
    /** `GET /api/logs/entries/:insertId`: one full entry. */
    getEntry: (insertId: string) =>
      http.get<LogEntry>(`/api/logs/entries/${encodeURIComponent(insertId)}`),
    /** `GET /api/logs/tail`: entries after a seq cursor, in arrival order; can long-poll. */
    tail: (query: LogTailQuery = {}) => http.get<LogTailResult>('/api/logs/tail', q(query)),
    /** `GET /api/logs/histogram`: counts per severity in ~50 time buckets. */
    histogram: (query: LogFilterQuery = {}) =>
      http.get<LogHistogram>('/api/logs/histogram', q(query)),
    /** `GET /api/logs/summary`: error fingerprints (default WARNING+, last 30m). */
    summary: (query: LogSummaryQuery = {}) => http.get<LogSummary>('/api/logs/summary', q(query)),
    /** `GET /api/logs/services`: per-service traffic and error counts (default last 1h). */
    services: (query: LogFilterQuery = {}) =>
      http.get<LogServicesResult>('/api/logs/services', q(query)),
    /**
     * URL of the Server-Sent Events stream: `event: log`, `id: <seq>`, data = LogEntry JSON, in
     * arrival order. Starts live (or after `after_seq` / `Last-Event-ID`); `: heartbeat` comments
     * every 15s; `event: reset` when the API is reset (clear any local view).
     */
    streamUrl: (query: LogStreamQuery = {}) => `${baseUrl}/api/logs/stream${toQuery(q(query))}`,

    /** `POST /api/alerts` (create, or bump an open alert with the same dedupe_key) */
    raiseAlert: (body: AlertInput) => http.post<Alert>('/api/alerts', body),
    /** `PATCH /api/alerts/:id` */
    updateAlert: (id: number, body: AlertUpdate) => http.patch<Alert>(`/api/alerts/${id}`, body),
    /** `GET /api/alerts` */
    listAlerts: (query: AlertListQuery = {}) => http.get<Page<Alert>>('/api/alerts', q(query)),
    /** `GET /api/alerts/:id` */
    getAlert: (id: number) => http.get<Alert>(`/api/alerts/${id}`),
  };
}

export type LogsClient = ReturnType<typeof createLogsClient>;
