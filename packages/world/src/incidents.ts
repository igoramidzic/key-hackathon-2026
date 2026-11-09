/**
 * Past major incidents seeded as resolved records in ServiceNow. (Teams starts with a single
 * General channel; incident channels only exist once something creates them.)
 * Numbers are fixed and fall where the incident's open time lands in ServiceNow's seeded history
 * (incidents are numbered in opened order). Times are relative to process start / last reset.
 */
export interface PastMajorIncident {
  /** ServiceNow incident number. */
  number: string;
  /** Teams channel slug; the channel is named `<number lowercased>-<slug>`. */
  slug: string;
  /** Affected app (ServiceNow configuration item). */
  tla: string;
  /** Upstream app whose support was pulled into the incident. */
  extraTla?: string;
  priority: 'P2' | 'P3';
  /** 1 = High, 2 = Medium, 3 = Low; `priority` follows the standard matrix. */
  impact: 1 | 2 | 3;
  urgency: 1 | 2 | 3;
  /** Hours before now the incident was opened (and its Teams channel created). */
  hoursAgo: number;
  /** Minutes from open to resolution. */
  durationMin: number;
  /** ServiceNow short description. */
  shortDescription: string;
  /** Monitoring alert that opened the incident. */
  alert: string;
  category: 'application' | 'network' | 'batch_job' | 'performance';
  subcategory: string;
  /** One-line impact statement (incident description, Teams channel header). */
  summary: string;
  /** Root cause, lowercase start, ends with a period. */
  cause: string;
  /** What the on-call applied, lowercase start, no trailing period. */
  action: string;
  /** What fixed it, lowercase start, ends with a period. */
  fix: string;
  closeCode: 'Solution provided' | 'Workaround provided' | 'Resolved by change';
  closeNotes: string;
}

export const PAST_MAJOR_INCIDENTS: readonly PastMajorIncident[] = [
  {
    number: 'INC0010192',
    slug: 'ach-file-transmission-delay',
    tla: 'ACH',
    priority: 'P2',
    impact: 1,
    urgency: 2,
    hoursAgo: 74,
    durationMin: 95,
    shortDescription: 'ACH - outbound NACHA file for the 2pm window not transmitted to the Fed',
    alert:
      'FedACH transmission for the 2pm window not acknowledged within 15 minutes (ach-origination)',
    category: 'batch_job',
    subcategory: 'File transfer',
    summary: 'The outbound NACHA file for the 2pm window was not transmitted to the Fed.',
    cause:
      "an expired SFTP host key on the Fed transmission gateway after last night's certificate rotation.",
    action: 'updating the known_hosts entry on the gateway and re-sending the file',
    fix: 'updated the known_hosts entry and re-sent the file; the Fed confirmed receipt at 15:41 ET.',
    closeCode: 'Solution provided',
    closeNotes:
      'SFTP host key verification failed on the Fed transmission gateway after the overnight certificate rotation, so the 2pm NACHA file was never sent. Updated the known_hosts entry and re-sent the file; the Fed confirmed receipt at 15:41 ET. Host key update added to the certificate rotation runbook.',
  },
  {
    number: 'INC0010200',
    slug: 'mobile-login-timeouts',
    tla: 'MBL',
    extraTla: 'ATH',
    priority: 'P2',
    impact: 2,
    urgency: 1,
    hoursAgo: 30,
    durationMin: 70,
    shortDescription: 'MBL - mobile app logins timing out for ~18% of customers',
    alert: 'Login failure rate 18% on mobile-gateway (threshold 2%)',
    category: 'application',
    subcategory: 'Configuration',
    summary: 'Mobile app logins timing out for roughly 18% of customers.',
    cause:
      'token validation calls from mobile-gateway to ATH saturated the HTTP connection pool after a config change lowered max connections from 200 to 20.',
    action: 'reverting the pool size change and rolling the mobile-gateway pods',
    fix: 'reverted the pool size change and rolled the mobile-gateway pods.',
    closeCode: 'Resolved by change',
    closeNotes:
      'A config change lowered the mobile-gateway HTTP connection pool to ATH from 200 to 20 max connections, so token validation calls queued and logins timed out. Reverted the pool size and rolled the mobile-gateway pods; login success rate back to normal.',
  },
  {
    number: 'INC0010202',
    slug: 'wire-status-delays',
    tla: 'WIR',
    priority: 'P3',
    impact: 2,
    urgency: 2,
    hoursAgo: 9,
    durationMin: 50,
    shortDescription: 'WIR - outgoing wire status updates delayed up to 40 minutes',
    alert: 'Kafka consumer lag above 5,000 messages on topic wire-status (wire-transfer-service)',
    category: 'application',
    subcategory: 'Integration',
    summary: 'Outgoing wire status updates delayed by up to 40 minutes.',
    cause: 'a stuck consumer on the wire-status Kafka topic after a broker failover.',
    action: 'restarting the wire-status consumer group',
    fix: 'restarted the consumer group; the backlog drained in 12 minutes.',
    closeCode: 'Solution provided',
    closeNotes:
      'The wire-status consumer group stopped committing offsets after a Kafka broker failover, delaying outgoing wire status updates by up to 40 minutes. Restarted the consumer group; the backlog drained in 12 minutes.',
  },
];

/** Teams channel name for a past major incident, e.g. `inc0010192-ach-file-transmission-delay`. */
export function incidentChannelName(inc: Pick<PastMajorIncident, 'number' | 'slug'>): string {
  return `${inc.number.toLowerCase()}-${inc.slug}`;
}
