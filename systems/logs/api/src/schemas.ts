import { csv } from '@sim/api-kit';
import { SEVERITIES } from '@sim/contracts/logs';
import { z } from 'zod';

const upper = (v: unknown) => (typeof v === 'string' ? v.toUpperCase() : v);
const lower = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v);

export const severitySchema = z.preprocess(upper, z.enum(SEVERITIES));

const isoTimestamp = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'must be an ISO 8601 timestamp')
  .transform((v) => new Date(v).toISOString());

const labelValue = z.coerce.string();

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export const logEntryInputSchema = z.looseObject({
  insertId: z.string().min(1).max(128).optional(),
  logName: z.string().min(1),
  timestamp: isoTimestamp,
  severity: severitySchema,
  resource: z.looseObject({
    type: z.string().default('k8s_container'),
    labels: z
      .object({
        project_id: labelValue.optional(),
        location: labelValue.optional(),
        cluster_name: labelValue.optional(),
        namespace_name: labelValue.optional(),
        pod_name: labelValue.optional(),
        container_name: z.string().min(1),
      })
      .catchall(labelValue),
  }),
  labels: z
    .object({
      app_tla: z.string().min(1),
      app_name: labelValue.optional(),
      env: labelValue.optional(),
      version: labelValue.optional(),
    })
    .catchall(labelValue),
  jsonPayload: z.record(z.string(), z.unknown()).optional(),
  textPayload: z.string().optional(),
  httpRequest: z
    .looseObject({
      requestMethod: z.string(),
      requestUrl: z.string(),
      status: z.coerce.number().int(),
      latency: z.union([z.string(), z.number().transform((n) => `${n}s`)]).optional(),
    })
    .optional(),
  trace: z.string().optional(),
  spanId: z.string().optional(),
});

export const ingestSchema = z.object({
  entries: z.array(logEntryInputSchema).max(10_000),
});

// ---------------------------------------------------------------------------
// Log queries
// ---------------------------------------------------------------------------

export const filterShape = {
  filter: z.string().optional(),
  severity: severitySchema.optional(),
  app_tla: csv,
  service: csv,
  q: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
};

const seq = z.coerce.number().int().min(0);

export const searchSchema = z.object({
  ...filterShape,
  after_seq: seq.optional(),
  order: z.preprocess(lower, z.enum(['asc', 'desc'])).default('desc'),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  cursor: z.string().optional(),
});

export const tailSchema = z.object({
  ...filterShape,
  after_seq: seq.optional(),
  wait_seconds: z.coerce.number().min(0).max(30).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export const streamSchema = z.object({ ...filterShape, after_seq: seq.optional() });

export const windowSchema = z.object(filterShape);

export const summarySchema = z.object({
  ...filterShape,
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export const alertSeveritySchema = z.preprocess(
  lower,
  z.enum(['critical', 'major', 'minor', 'warning', 'clear']),
);
export const alertStatusSchema = z.preprocess(
  lower,
  z.enum(['open', 'acknowledged', 'resolved', 'closed']),
);
const managerSchema = z.enum([
  'AppDynamics',
  'GCP Monitoring',
  'Prometheus',
  'Synthetics',
  'Splunk',
  'SolarWinds',
]);

export const alertInputSchema = z.object({
  severity: alertSeveritySchema,
  description: z.string().min(1),
  source: z.string().min(1),
  service: z.string().min(1),
  app_tla: z.string().min(2).max(6),
  manager: managerSchema,
  class: z.string().min(1),
  check: z.string().min(1),
  dedupe_key: z.string().min(1),
  custom_info: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  event_time: isoTimestamp.optional(),
});

export const alertUpdateSchema = z
  .object({
    status: alertStatusSchema.optional(),
    severity: alertSeveritySchema.optional(),
    owner: z.string().min(1).nullable().optional(),
    incident_number: z.string().min(1).nullable().optional(),
    note: z.object({ author: z.string().min(1), text: z.string().min(1) }).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Provide at least one of status, severity, owner, incident_number, note',
  });

export const alertListSchema = z.object({
  status: csv,
  severity: csv,
  app_tla: csv,
  service: csv,
  q: z.string().optional(),
  since: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(25),
  cursor: z.string().optional(),
});
