import { URLS } from '@sim/contracts';
import {
  type Alert,
  composeLogFilter,
  createLogsClient,
  type LogEntry,
  type LogFilterQuery,
  logMessage,
  logsExplorerUrl,
  SEVERITIES,
  type Severity,
} from '@sim/contracts/logs';
import {
  defineTool,
  type McpServer,
  type McpServerSpec,
  paginationShape,
  READ_ONLY,
  WRITE,
} from '@sim/mcp-kit';
import { z } from 'zod';

export const api = createLogsClient(process.env.LOGS_API_URL ?? URLS.logs.api);

const BOT = 'svc_incident_auto';

// ---------------------------------------------------------------------------
// Shared input fields
// ---------------------------------------------------------------------------

const FILTER_HELP = [
  'Logging query language filter (subset of GCP Cloud Logging). Terms separated by spaces or',
  'newlines are ANDed.',
  'Fields: severity, timestamp, insertId, trace, logName, labels.app_tla (ServiceNow TLA, e.g.',
  '"PAY"), labels.app_name, resource.labels.container_name (service, e.g. "payments-api"),',
  'resource.labels.pod_name, resource.labels.namespace_name, jsonPayload.message,',
  'jsonPayload.logger, jsonPayload.error.type, jsonPayload.error.message, httpRequest.status,',
  'httpRequest.requestMethod, httpRequest.requestUrl, httpRequest.latency (e.g. "1.5s"),',
  'textPayload. Shortcuts: service, tla, message, status.',
  'Operators: = exact, != not equal, : contains (case-insensitive; field:* = field present),',
  '=~ / !~ regex, > >= < <= (severity by rank DEFAULT<DEBUG<INFO<NOTICE<WARNING<ERROR<CRITICAL',
  '<ALERT<EMERGENCY, numbers numerically, timestamps by time).',
  'Boolean: AND, OR, NOT, leading "-" to negate, parentheses; OR binds tighter than AND.',
  'Value lists: labels.app_tla=("PAY" OR "DEP"). A bare word or "quoted phrase" is a full-text',
  'search over message, payload, URL and labels.',
  'Examples: `severity>=ERROR resource.labels.container_name="payments-api"`;',
  '`jsonPayload.error.type:"SocketTimeout" OR jsonPayload.message:"timed out"`;',
  '`httpRequest.status>=500 -labels.app_tla="ATH"`; `trace="projects/kb-prod-pay00/traces/4bf9…"`.',
].join(' ');

const TIME_HELP = 'ISO 8601 (e.g. "2026-11-09T14:30:00Z") or relative to now: "15m", "2h", "1d".';

const filterInput = {
  filter: z.string().optional().describe(FILTER_HELP),
  severity_min: z
    .enum(SEVERITIES)
    .optional()
    .describe('Minimum severity, e.g. "ERROR" (includes CRITICAL, ALERT, EMERGENCY).'),
  app_tla: z
    .string()
    .optional()
    .describe('Only these apps: ServiceNow TLA(s), comma-separated, e.g. "PAY" or "PAY,DEP".'),
  service: z
    .string()
    .optional()
    .describe('Only these services (k8s container names), comma-separated, e.g. "payments-api".'),
  text: z
    .string()
    .optional()
    .describe(
      'Free-text phrase, case-insensitive substring over message, payload, URL and labels, e.g. "timed out".',
    ),
};

const timeInput = (defaultStart: string) => ({
  start_time: z
    .string()
    .optional()
    .describe(`Start of the time window. ${TIME_HELP} Default: "${defaultStart}".`),
  end_time: z.string().optional().describe(`End of the time window. ${TIME_HELP} Default: now.`),
});

type FilterArgs = {
  filter?: string;
  severity_min?: Severity;
  app_tla?: string;
  service?: string;
  text?: string;
  start_time?: string;
  end_time?: string;
};

function toQuery(args: FilterArgs, defaultStart?: string): LogFilterQuery {
  return {
    filter: args.filter,
    severity: args.severity_min,
    app_tla: args.app_tla,
    service: args.service,
    q: args.text,
    since: args.start_time ?? defaultStart,
    until: args.end_time,
  };
}

/** Logs Explorer link for the same query (relative ranges only; ISO ranges fall back to 1h). */
function logsUrl(args: FilterArgs, defaultStart: string): string {
  const filter = composeLogFilter({
    filter: args.filter,
    severity: args.severity_min,
    app_tla: args.app_tla,
    service: args.service,
    text: args.text,
  });
  const start = args.start_time ?? defaultStart;
  return logsExplorerUrl(filter, /^\d+[smhd]$/.test(start) ? start : undefined);
}

// ---------------------------------------------------------------------------
// Compact shapes
// ---------------------------------------------------------------------------

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text;

function trimEntry(e: LogEntry, withSeq = false) {
  const out: Record<string, unknown> = { insert_id: e.insertId };
  if (withSeq) out.seq = e.seq;
  out.timestamp = e.timestamp;
  out.severity = e.severity;
  out.app_tla = e.labels?.app_tla;
  out.service = e.resource?.labels?.container_name;
  out.message = truncate(logMessage(e), 300);
  if (e.jsonPayload?.error?.type) out.error_type = e.jsonPayload.error.type;
  if (e.httpRequest) {
    out.http = {
      method: e.httpRequest.requestMethod,
      url: e.httpRequest.requestUrl,
      status: e.httpRequest.status,
      latency: e.httpRequest.latency,
    };
  }
  if (e.trace) out.trace = e.trace;
  return out;
}

function compactAlert(a: Alert) {
  return {
    id: a.id,
    severity: a.severity,
    status: a.status,
    description: a.description,
    app_tla: a.app_tla,
    service: a.service,
    source: a.source,
    manager: a.manager,
    check: a.check,
    event_count: a.event_count,
    first_event_time: a.first_event_time,
    last_event_time: a.last_event_time,
    owner: a.owner,
    incident_number: a.incident_number,
    web_url: a.web_url,
  };
}

const ALERT_STATUSES = ['open', 'acknowledged', 'resolved', 'closed'] as const;
const ALERT_SEVERITIES = ['critical', 'major', 'minor', 'warning', 'clear'] as const;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function register(server: McpServer) {
  defineTool(server, 'search_logs', {
    title: 'Search logs',
    description: [
      'Search Cloud Logging entries with a Logs Explorer filter plus convenience params (all ANDed),',
      'ordered by timestamp (newest first by default). Use it to read the actual log lines behind an',
      'error pattern, follow a trace across services, or check what a service logged around a time.',
      'Default window is the last 1h. Returns { total, items, next_cursor, logs_url } where each item',
      'is trimmed: insert_id, timestamp, severity, app_tla, service, message (≤300 chars), error_type,',
      'http {method,url,status,latency}, trace. Use get_log_entry(insert_id) for the full entry',
      '(stack trace, all payload fields). Start with summarize_errors when you do not know what to',
      'look for yet. logs_url opens the same query in the Logs Explorer UI.',
    ].join(' '),
    input: {
      ...filterInput,
      ...timeInput('1h'),
      order: z
        .enum(['desc', 'asc'])
        .default('desc')
        .describe('By timestamp: "desc" newest first (default) or "asc" oldest first.'),
      ...paginationShape,
    },
    annotations: READ_ONLY,
    run: async (args) => {
      const page = await api.search({
        ...toQuery(args, '1h'),
        order: args.order,
        limit: args.limit,
        cursor: args.cursor,
      });
      return {
        total: page.total,
        returned: page.items.length,
        items: page.items.map((e) => trimEntry(e)),
        next_cursor: page.next_cursor,
        logs_url: logsUrl(args, '1h'),
      };
    },
  });

  defineTool(server, 'get_log_entry', {
    title: 'Get log entry',
    description:
      'Fetch one complete log entry by insert_id (from search_logs, tail_logs or summarize_errors ' +
      'sample_insert_id): full jsonPayload including error.stack_trace, httpRequest, resource and ' +
      'labels (pod, namespace, cluster, version), trace and spanId. Use it after search_logs when you ' +
      'need the stack trace or exact payload. Returns the GCP LogEntry JSON.',
    input: {
      insert_id: z
        .string()
        .min(1)
        .describe('The entry\'s insert_id / insertId, e.g. "mw9q41da00000s".'),
    },
    annotations: READ_ONLY,
    run: async ({ insert_id }) => api.getEntry(insert_id),
  });

  defineTool(server, 'tail_logs', {
    title: 'Tail logs',
    description: [
      'Follow new log entries in arrival order, like `tail -f`. Without after_seq it returns the',
      'latest `limit` matching entries. With after_seq (the cursor from the previous call) it',
      'returns matching entries that arrived since; if none have arrived yet it waits up to',
      'wait_seconds for new ones (long-poll). Always pass the returned cursor as after_seq next time.',
      'Use it to watch a service live, e.g. to confirm errors stop after a fix or rollback.',
      'Returns { items (trimmed, with seq), cursor, has_more, last_seq }; has_more=true means call',
      'again immediately. Not time-windowed unless start_time/end_time are given.',
    ].join(' '),
    input: {
      ...filterInput,
      start_time: z.string().optional().describe(`Optional lower bound on timestamp. ${TIME_HELP}`),
      end_time: z.string().optional().describe(`Optional upper bound on timestamp. ${TIME_HELP}`),
      after_seq: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          'Cursor from the previous tail_logs call (a seq number). Omit on the first call.',
        ),
      wait_seconds: z
        .number()
        .min(0)
        .max(30)
        .default(0)
        .describe(
          'With after_seq: wait up to this many seconds (0-30) for new entries. Default 0.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(50)
        .describe('Maximum entries to return (1-200, default 50).'),
    },
    annotations: READ_ONLY,
    run: async (args) => {
      const res = await api.tail({
        ...toQuery(args),
        after_seq: args.after_seq,
        wait_seconds: args.after_seq === undefined ? undefined : args.wait_seconds,
        limit: args.limit,
      });
      return {
        items: res.items.map((e) => trimEntry(e, true)),
        cursor: res.cursor,
        has_more: res.has_more,
        last_seq: res.last_seq,
      };
    },
  });

  defineTool(server, 'summarize_errors', {
    title: 'Summarize errors',
    description: [
      'Group recent problem log lines into fingerprints: same app_tla + service + normalized message',
      '(numbers, ids, amounts, account masks and quoted values replaced by placeholders). This is the',
      'best first call in an investigation: it shows which apps/services are failing, how often, and',
      'when each pattern started (first_seen = onset) and was last seen, i.e. the blast radius.',
      'Defaults: severity >= WARNING, last 30m. Returns { since, until, total_matched, items } sorted',
      'by count, each { app_tla, service, severity (highest), fingerprint, pattern, count, first_seen,',
      'last_seen, sample_message, sample_insert_id, error_type, http_status }. Pass',
      'sample_insert_id to get_log_entry for the stack trace.',
    ].join(' '),
    input: {
      ...filterInput,
      severity_min: z
        .enum(SEVERITIES)
        .default('WARNING')
        .describe('Minimum severity to include. Default "WARNING"; use "ERROR" for errors only.'),
      ...timeInput('30m'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(25)
        .describe('Maximum fingerprints to return (1-100, default 25).'),
    },
    annotations: READ_ONLY,
    run: async (args) => {
      const res = await api.summary({ ...toQuery(args, '30m'), limit: args.limit });
      return {
        since: res.since,
        until: res.until,
        total_matched: res.total_matched,
        items: res.items.map((f) => ({ ...f, sample_message: truncate(f.sample_message, 300) })),
        logs_url: logsUrl(args, '30m'),
      };
    },
  });

  defineTool(server, 'get_log_histogram', {
    title: 'Get log histogram',
    description: [
      'Count matching log entries over time in ~50-60 equal buckets, split by severity (the Logs',
      'Explorer histogram). Use it to pinpoint when an error rate started rising or stopped, or to',
      'compare before/after a deploy. Default window: last 1h. Returns { since, until,',
      'bucket_seconds, total, buckets: [{ start, total, ERROR?, WARNING?, INFO?, … }] } (severities',
      'with zero counts are omitted).',
    ].join(' '),
    input: { ...filterInput, ...timeInput('1h') },
    annotations: READ_ONLY,
    run: async (args) => {
      const h = await api.histogram(toQuery(args, '1h'));
      return {
        since: h.since,
        until: h.until,
        bucket_seconds: h.bucket_seconds,
        total: h.total,
        buckets: h.buckets.map((b) => ({ start: b.start, total: b.total, ...b.counts })),
      };
    },
  });

  defineTool(server, 'list_log_services', {
    title: 'List log services',
    description: [
      'List services (k8s containers) that logged in the window with traffic and error counts:',
      '{ service, app_tla, app_name, total, errors (>= ERROR), warnings, error_rate (0-1),',
      'counts per severity, last_seen, last_error_at }, sorted by errors desc. Use it to see which',
      'services are unhealthy right now and to map services to app TLAs. Default window: last 1h.',
    ].join(' '),
    input: {
      ...filterInput,
      ...timeInput('1h'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(50)
        .describe('Maximum services to return (1-200, default 50).'),
    },
    annotations: READ_ONLY,
    run: async (args) => {
      const res = await api.services(toQuery(args, '1h'));
      return {
        since: res.since,
        until: res.until,
        total_services: res.items.length,
        items: res.items.slice(0, args.limit),
      };
    },
  });

  defineTool(server, 'list_alerts', {
    title: 'List alerts',
    description: [
      'List Moogsoft alerts (raised by AppDynamics, GCP Monitoring, Prometheus, Synthetics, Splunk,',
      'SolarWinds), newest activity first. Defaults to active alerts (open + acknowledged). Use it to',
      'see what monitoring has already flagged for an app or service and whether someone owns it.',
      'Returns { total, items: [{ id, severity, status, description, app_tla, service, source,',
      'manager, check, event_count, first_event_time, last_event_time, owner, incident_number,',
      'web_url }], next_cursor }. Use get_alert for notes and custom_info.',
    ].join(' '),
    input: {
      status: z
        .array(z.enum(ALERT_STATUSES))
        .default(['open', 'acknowledged'])
        .describe(
          'Statuses to include. Default ["open","acknowledged"]; add "resolved","closed" for history.',
        ),
      severity: z
        .array(z.enum(ALERT_SEVERITIES))
        .optional()
        .describe('Severities to include, e.g. ["critical","major"].'),
      app_tla: z.string().optional().describe('TLA(s), comma-separated, e.g. "PAY,DEP".'),
      service: z
        .string()
        .optional()
        .describe('Service name(s), comma-separated, e.g. "payments-api".'),
      text: z
        .string()
        .optional()
        .describe(
          'Substring over id, description, source, service, check, owner, incident number.',
        ),
      since: z
        .string()
        .optional()
        .describe(`Only alerts with an event at or after this time. ${TIME_HELP}`),
      ...paginationShape,
    },
    annotations: READ_ONLY,
    run: async (args) => {
      const page = await api.listAlerts({
        status: args.status.join(','),
        severity: args.severity?.join(','),
        app_tla: args.app_tla,
        service: args.service,
        q: args.text,
        since: args.since,
        limit: args.limit,
        cursor: args.cursor,
      });
      return {
        total: page.total,
        items: page.items.map(compactAlert),
        next_cursor: page.next_cursor,
      };
    },
  });

  defineTool(server, 'get_alert', {
    title: 'Get alert',
    description:
      'Fetch one Moogsoft alert by numeric id with everything: description, source host/pod, ' +
      'service, app_tla, manager, class, check, dedupe_key, first/last event time, event_count, ' +
      'owner, linked incident_number, notes (journal) and custom_info (metric value, threshold, ' +
      'cluster…), plus web_url.',
    input: { id: z.number().int().describe('Alert id, e.g. 48216.') },
    annotations: READ_ONLY,
    run: async ({ id }) => api.getAlert(id),
  });

  defineTool(server, 'update_alert', {
    title: 'Update alert',
    description: [
      'Update a Moogsoft alert: acknowledge it, take ownership, link the ServiceNow incident,',
      'add a note to its journal, or resolve/close it once the issue is fixed. Only the fields you',
      'pass change; a note is appended (attributed to `author`). Typical: when you open an incident',
      'for an alert, call with status "acknowledged", owner, incident_number and a note; after the',
      'fix is verified, status "resolved" with a note. Returns the updated alert.',
    ].join(' '),
    input: {
      id: z.number().int().describe('Alert id, e.g. 48216.'),
      status: z
        .enum(ALERT_STATUSES)
        .optional()
        .describe('New status: "acknowledged", "resolved", "closed" (or "open" to reopen).'),
      owner: z
        .string()
        .nullable()
        .optional()
        .describe(`Username that owns the alert, e.g. "${BOT}"; null to clear.`),
      incident_number: z
        .string()
        .nullable()
        .optional()
        .describe('ServiceNow incident to link, e.g. "INC0012345"; null to unlink.'),
      severity: z.enum(ALERT_SEVERITIES).optional().describe('Override the severity.'),
      note: z.string().optional().describe('Text to append to the alert journal.'),
      author: z.string().default(BOT).describe(`Username recorded on the note. Default "${BOT}".`),
    },
    annotations: WRITE,
    run: async (args) => {
      const { id, note, author, ...rest } = args;
      const body = {
        ...rest,
        ...(note ? { note: { author, text: note } } : {}),
      };
      if (Object.values(body).every((v) => v === undefined)) {
        throw new Error(
          'Nothing to update: pass status, owner, incident_number, severity or note.',
        );
      }
      return api.updateAlert(id, body);
    },
  });
}

export const spec: McpServerSpec = {
  name: 'logs',
  title: 'Cloud Logging & Moogsoft (simulated)',
  version: '0.1.0',
  instructions: [
    'Simulated GCP Cloud Logging (Logs Explorer) and Moogsoft alerting for KeyBank production.',
    'Log entries use the GCP LogEntry shape: labels.app_tla is the ServiceNow application TLA',
    '(e.g. PAY, DEP); resource.labels.container_name is the service (k8s container, e.g.',
    'payments-api); jsonPayload.message is the message and jsonPayload.error.{type,message,',
    'stack_trace} the exception; httpRequest.status the HTTP status; trace ties together one',
    'request across services. Filters use the Logs Explorer query language (see search_logs).',
    'Investigation workflow: summarize_errors (which services fail, counts, onset) →',
    'list_log_services / get_log_histogram (blast radius and timing) → search_logs (read the',
    'lines, follow a trace) → get_log_entry (stack trace). Use tail_logs with its cursor to watch',
    'live, e.g. to verify a fix. Alerts: list_alerts → get_alert → update_alert (acknowledge,',
    'owner, link incident_number, notes, resolve). Times are UTC ISO 8601; time inputs also accept',
    'relative values like "15m", "2h". Alerts carry web_url and log searches return logs_url',
    'for linking from incidents.',
  ].join(' '),
  register,
};
