/**
 * Conventions shared by every system's REST API:
 * - JSON bodies use snake_case keys (log entries keep GCP's camelCase LogEntry shape).
 * - List endpoints accept `limit` and `cursor` and return `Page<T>`.
 * - Errors return `{ "error": "message" }` with a 4xx/5xx status.
 * - Every API serves `GET /health` and `POST /admin/reset` (restore the seeded baseline).
 */
export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page, or null when there are no more items. */
  next_cursor: string | null;
  /** Total matching items when cheap to compute. */
  total?: number;
}

export interface Health {
  status: 'ok';
  service: string;
  started_at: string;
  /** System-specific counters for the control panel. */
  stats?: Record<string, number>;
}

export interface ResetResult {
  ok: true;
  service: string;
  reset_at: string;
}
