/** Log helpers shared by triage, verification and the briefing. */
import type { Mcp } from '../mcp/gateway';

export interface Fingerprint {
  app_tla: string;
  service: string;
  severity: string;
  fingerprint: string;
  pattern: string;
  count: number;
  first_seen: string;
  last_seen: string;
  sample_message: string;
  sample_insert_id: string;
  error_type?: string;
  http_status?: number;
}

export interface Summary {
  total_matched: number;
  items: Fingerprint[];
  logs_url?: string;
}

export interface SearchResult {
  total: number;
  items: {
    insert_id: string;
    timestamp: string;
    severity: string;
    app_tla: string;
    service: string;
    message: string;
    error_type?: string;
    trace?: string;
  }[];
  logs_url: string;
}

const quote = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function tlaClause(apps: string[]): string {
  if (apps.length === 1) return `labels.app_tla=${quote(apps[0]!)}`;
  return `labels.app_tla=(${apps.map(quote).join(' OR ')})`;
}

export function sinceClause(iso: string): string {
  return `timestamp>=${quote(iso)}`;
}

export function messageClause(text: string): string {
  return `jsonPayload.message:${quote(text)}`;
}

/**
 * The longest literal run in a normalised pattern ("<n> customerId missing from profile" →
 * "customerId missing from profile"), good for a `jsonPayload.message:` filter.
 */
export function literalPhrase(pattern: string, sample: string): string | null {
  const parts = pattern
    .split(/<[^>]+>/)
    .map((p) => p.trim().replace(/^[:;,.\s-]+|[:;,.\s-]+$/g, ''));
  const best = parts.sort((a, b) => b.length - a.length)[0] ?? '';
  if (best.length < 12) return null;
  // Use the sample's casing when it contains the phrase.
  const i = sample.toLowerCase().indexOf(best.toLowerCase());
  return i >= 0 ? sample.slice(i, i + best.length) : best;
}

/** Runs a filter and returns the Logs Explorer link the tool gave back, with the match count. */
export async function logLink(
  mcp: Mcp,
  filter: string,
  caseId?: string,
): Promise<{ filter: string; logs_url: string; total: number }> {
  const res = await mcp.call<SearchResult>(
    'search_logs',
    { filter, start_time: '6h', limit: 1 },
    { caseId },
  );
  return { filter, logs_url: res.logs_url, total: res.total };
}

/** Errors per minute for the given apps between two times (from list_log_services). */
export async function errorRate(
  mcp: Mcp,
  apps: string[],
  since: string,
  until?: string,
  severity = 'ERROR',
  caseId?: string,
): Promise<{ perMin: number; errors: number; total: number; minutes: number }> {
  const sum = await mcp.call<Summary>(
    'summarize_errors',
    {
      app_tla: apps.join(','),
      severity_min: severity,
      start_time: since,
      end_time: until,
      limit: 100,
    },
    { caseId, quiet: true },
  );
  const minutes = Math.max(
    0.25,
    ((until ? Date.parse(until) : Date.now()) - Date.parse(since)) / 60_000,
  );
  return {
    perMin: sum.total_matched / minutes,
    errors: sum.total_matched,
    total: sum.total_matched,
    minutes,
  };
}
