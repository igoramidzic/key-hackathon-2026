import { URLS } from '../config';
import type { Severity } from './types';

export interface FilterParts {
  /** Raw query-language filter. */
  filter?: string;
  severity?: Severity;
  app_tla?: string | string[];
  service?: string | string[];
  /** Free text. */
  text?: string;
}

const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const list = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value : (value ?? '').split(',')).map((v) => v.trim()).filter(Boolean);

function anyOf(field: string, values: string[]): string | null {
  if (values.length === 0) return null;
  if (values.length === 1) return `${field}=${quote(values[0]!)}`;
  return `(${values.map((v) => `${field}=${quote(v)}`).join(' OR ')})`;
}

/**
 * Combines convenience params into one Logging query language filter (one clause per line),
 * e.g. for "Open in Logs Explorer" links.
 */
export function composeLogFilter(parts: FilterParts): string {
  const lines: string[] = [];
  if (parts.severity) lines.push(`severity>=${parts.severity}`);
  const tla = anyOf(
    'labels.app_tla',
    list(parts.app_tla).map((t) => t.toUpperCase()),
  );
  if (tla) lines.push(tla);
  const svc = anyOf('resource.labels.container_name', list(parts.service));
  if (svc) lines.push(svc);
  if (parts.filter?.trim()) lines.push(parts.filter.trim());
  if (parts.text?.trim()) lines.push(quote(parts.text.trim()));
  return lines.join('\n');
}

/** `http://localhost:3001/logs?query=…&range=1h` */
export function logsExplorerUrl(filter: string, range?: string, base = URLS.logs.web): string {
  const params = new URLSearchParams();
  if (filter) params.set('query', filter);
  if (range) params.set('range', range);
  const qs = params.toString();
  return `${base}/logs${qs ? `?${qs}` : ''}`;
}

/** `http://localhost:3001/alerts/48213` */
export function alertWebUrl(id: number, base = URLS.logs.web): string {
  return `${base}/alerts/${id}`;
}
