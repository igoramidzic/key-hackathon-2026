import type {
  AppRecord,
  AppState,
  LogEntry,
  Incident,
  ChatMessage,
  SimulationEvent,
  SimulationControls,
  Phase,
  ScenarioKey,
  ControlInput,
} from './types.ts';
export type * from './types.ts';

/** Synthetic incident playground. No credentials or external service connections. */
export const SCENARIOS = {
  'db-pool': {
    label: 'Database connection exhaustion',
    title: 'Database connection pool exhausted',
    error: 'HikariPool-1 - Connection is not available, request timed out after 30000ms',
    summary:
      'Requests are failing because the application has exhausted its database connection pool.',
    hypothesis:
      'A recent deployment increased worker concurrency from 20 to 80 while the PostgreSQL pool remained at 40 connections. Correlated pool-wait timeouts and HTTP 503s suggest connection contention, not a database outage.',
    fix: 'Review CHG0031842, then roll back the concurrency change or reduce worker concurrency to 20. Confirm pool utilization falls below 70% and the 5xx rate stays below 1% for five minutes.',
    metric: 'db.pool.active=40 db.pool.max=40 db.pool.pending=137',
    code: 'POOL_EXHAUSTED',
  },
  'bad-deploy': {
    label: 'Faulty deployment',
    title: 'Elevated errors after deployment',
    error: 'TypeError: Cannot read properties of undefined (reading settlementCurrency)',
    summary: 'A newly deployed version is returning HTTP 500 for requests with legacy payloads.',
    hypothesis:
      'Errors begin immediately after deployment v2.18.0 and only affect pods on the new version. A missing null check for legacy payloads is the likely regression.',
    fix: 'Review CHG0031842 and roll back v2.18.0 to v2.17.3. Verify the error fingerprint disappears and request success remains above 99% for five minutes.',
    metric: 'http.status=500 release=v2.18.0 error.fingerprint=7a2e31',
    code: 'DEPLOYMENT_REGRESSION',
  },
  latency: {
    label: 'Upstream latency spike',
    title: 'Upstream timeout cascade',
    error: 'io.netty.handler.timeout.ReadTimeoutException: upstream exceeded deadline of 5000ms',
    summary: 'An upstream dependency is responding slowly, causing retries and cascading timeouts.',
    hypothesis:
      'Upstream p99 latency rose before the application error rate. Retry amplification is saturating request workers; the application itself remains healthy when the dependency responds.',
    fix: 'Inspect the upstream service, enable the documented circuit breaker, and reduce retries to one. Confirm p99 latency is below 500ms and timeout volume returns to baseline.',
    metric: 'upstream.p99_ms=8274 retry.count=3 circuit_breaker=closed',
    code: 'UPSTREAM_TIMEOUT',
  },
};
const domains = [
  'checkout',
  'payments',
  'identity',
  'catalog',
  'inventory',
  'orders',
  'shipping',
  'search',
  'pricing',
  'notifications',
  'accounts',
  'billing',
  'fulfillment',
  'analytics',
  'recommendations',
  'loyalty',
  'returns',
  'fraud',
  'subscriptions',
  'merchant',
  'warehouse',
  'support',
  'media',
  'gateway',
];
const components = [
  'api',
  'worker',
  'scheduler',
  'events',
  'cache',
  'sync',
  'webhook',
  'gateway',
  'export',
  'processor',
];
const teams = [
  'Commerce Platform',
  'Payments Engineering',
  'Identity & Access',
  'Product Experience',
  'Supply Chain',
  'Order Management',
];
const people = [
  { name: 'Maya Chen', role: 'Primary on-call · Commerce', initials: 'MC' },
  { name: 'Alex Rivera', role: 'Service owner', initials: 'AR' },
  { name: 'Jordan Patel', role: 'Database reliability engineer', initials: 'JP' },
  { name: 'Sam Okafor', role: 'Incident commander', initials: 'SO' },
];
const iso = (ms: number) => new Date(ms).toISOString();
const regions = ['us-central1', 'us-east1', 'europe-west1'];
export function createApps(): AppRecord[] {
  return domains.flatMap((domain, i) =>
    components.map((component, j) => {
      const id = `${domain}-${component}`;
      return {
        id,
        slug: id,
        name: id,
        displayName: `${domain[0].toUpperCase()}${domain.slice(1)} ${component.toUpperCase()}`,
        team: teams[i % teams.length],
        tier: j < 2 ? 'Tier 1' : 'Tier 2',
        region: regions[(i + j) % 3],
        environment: 'production',
        status: 'healthy',
        owner: people[(i + 1) % people.length].name,
        onCall: people[i % people.length].name,
        runtime: j % 2 ? 'Node.js 22' : 'Java 21',
        version: 'v2.17.3',
        cluster: 'prod-services-01',
        project: 'acme-production',
        namespace: domain,
        dependencies: [`${domain}-postgres`, 'redis-session', 'payments-api'].filter(
          (dep) => dep !== id,
        ),
        repo: `acme/${id}`,
        serviceNowId: `CI${String(100100 + i * 10 + j)}`,
      };
    }),
  );
}
export interface SimulationSnapshot {
  version: 1;
  state: AppState;
  initialSeed: number;
  seed: number;
  sequence: number;
  totalIncidents: number;
  incidentElapsed: number;
  stages: Phase[];
}

export class Simulation {
  now: () => number;
  initialSeed: number;
  seed = 42;
  sequence = 0;
  totalLogs = 0;
  totalIncidents = 0;
  apps: AppRecord[] = [];
  logs: LogEntry[] = [];
  incidents: Incident[] = [];
  messages: ChatMessage[] = [];
  events: SimulationEvent[] = [];
  simulation!: SimulationControls;
  incidentElapsed = 0;
  stages = new Set<Phase>();
  generation = 0;
  constructor({ now = Date.now, seed = 42 }: { now?: () => number; seed?: number } = {}) {
    this.now = now;
    this.initialSeed = seed;
    this.reset();
  }
  snapshot(): SimulationSnapshot {
    return structuredClone({
      version: 1,
      state: this.state(),
      initialSeed: this.initialSeed,
      seed: this.seed,
      sequence: this.sequence,
      totalIncidents: this.totalIncidents,
      incidentElapsed: this.incidentElapsed,
      stages: [...this.stages],
    });
  }
  restore(snapshot: SimulationSnapshot): void {
    if (snapshot.version !== 1) throw new Error('Unsupported simulation snapshot version.');
    const saved = structuredClone(snapshot);
    const state = saved.state;
    this.apps = state.apps;
    this.logs = state.logs;
    this.incidents = state.incidents;
    this.messages = state.messages;
    this.events = state.events;
    this.simulation = state.simulation;
    this.totalLogs = state.stats.totalLogs;
    this.generation = state.generation;
    this.initialSeed = saved.initialSeed;
    this.seed = saved.seed;
    this.sequence = saved.sequence;
    this.totalIncidents = saved.totalIncidents;
    this.incidentElapsed = saved.incidentElapsed;
    this.stages = new Set(saved.stages);
  }
  random() {
    this.seed = (Math.imul(1664525, this.seed) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
  pick<T>(values: T[]): T {
    return values[Math.floor(this.random() * values.length)];
  }
  id(prefix: string) {
    return `${prefix}-${String(++this.sequence).padStart(7, '0')}`;
  }
  reset() {
    this.seed = this.initialSeed;
    this.sequence = 0;
    this.totalLogs = 0;
    this.totalIncidents = 0;
    this.apps = createApps();
    this.logs = [];
    this.incidents = [];
    this.messages = [];
    this.events = [];
    this.simulation = {
      running: true,
      speed: 1,
      phase: 'healthy',
      elapsed: 0,
      scenario: 'db-pool',
      targetAppId: 'checkout-api',
    };
    this.incidentElapsed = 0;
    this.stages = new Set();
    this.generation = (this.generation || 0) + 1;
    for (let i = 0; i < 144; i++) this.backgroundLog(this.now() - (144 - i) * 480);
    this.event(
      'Simulation ready',
      '240 synthetic applications connected across GCP, Kibana, and Moogsoft.',
      'system',
    );
    return this.state();
  }
  event(title: string, detail: string, type = 'info') {
    const event = { id: this.id('evt'), time: iso(this.now()), title, detail, type };
    this.events.push(event);
    this.events = this.events.slice(-60);
    return event;
  }
  log(
    appId: string,
    source: LogEntry['source'],
    severity: LogEntry['severity'],
    message: string,
    metadata: Record<string, unknown> = {},
    timestamp = this.now(),
  ) {
    const app = this.apps.find((a) => a.id === appId);
    const entry: LogEntry = {
      id: this.id('log'),
      timestamp: iso(timestamp),
      source,
      severity,
      appId,
      message,
      traceId: `${Math.floor(this.random() * 0xffffffff)
        .toString(16)
        .padStart(8, '0')}${Math.floor(this.random() * 0xffffffff)
        .toString(16)
        .padStart(8, '0')}`,
      metadata: {
        project: 'acme-production',
        cluster: 'prod-services-01',
        namespace: app?.namespace,
        region: app?.region,
        pod: `${appId}-7c8d9f-${Math.floor(this.random() * 900 + 100)}`,
        version: app?.version,
        ...metadata,
      },
    };
    this.logs.unshift(entry);
    this.totalLogs++;
    const pinned = new Set(this.incidents.flatMap((i) => i.evidence));
    const evidence = this.logs.filter((l) => pinned.has(l.id));
    this.logs = this.logs
      .filter((l) => !pinned.has(l.id))
      .slice(0, 300 - evidence.length)
      .concat(evidence)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return entry;
  }
  backgroundLog(timestamp = this.now()) {
    const app = this.pick(this.apps),
      source = this.pick<LogEntry['source']>(['gcp', 'gcp', 'kibana', 'kibana', 'moogsoft']);
    const latency = Math.floor(12 + this.random() * 155),
      severity = this.random() > 0.965 ? 'WARN' : this.random() > 0.86 ? 'DEBUG' : 'INFO';
    const msg =
      source === 'moogsoft'
        ? this.pick([
            'Heartbeat received; service status healthy',
            'Metric evaluation complete; no threshold violation',
            'Event deduplicated; topology correlation stable',
          ])
        : severity === 'WARN'
          ? 'Retry succeeded after transient connection reset; attempt=2'
          : this.pick([
              `GET /api/v1/${app.namespace} 200 ${latency}ms`,
              `POST /api/v1/${app.namespace}/validate 200 ${latency}ms`,
              `Health probe succeeded; ready=true duration=${Math.floor(latency / 10)}ms`,
              `Processed batch; records=${Math.floor(30 + this.random() * 200)} duration=${latency}ms`,
              `Cache lookup completed; hit=true duration=${Math.floor(latency / 15)}ms`,
              `Consumer offset committed; partition=2 lag=${Math.floor(this.random() * 8)}`,
            ]);
    this.log(app.id, source, severity, msg, { durationMs: latency, httpStatus: 200 }, timestamp);
  }
  message(
    author: string,
    role: ChatMessage['role'],
    text: string,
    extra: Partial<Pick<ChatMessage, 'links' | 'kind'>> = {},
  ) {
    const m = { id: this.id('msg'), author, role, text, timestamp: iso(this.now()), ...extra };
    this.messages.push(m);
    this.messages = this.messages.slice(-100);
    return m;
  }
  get incident(): Incident {
    return this.incidents[0];
  }
  get scenario() {
    return SCENARIOS[this.simulation.scenario];
  }
  timeline(title: string, detail: string) {
    if (this.incident) this.incident.timeline.push({ time: iso(this.now()), title, detail });
  }
  inject({
    scenario = 'db-pool',
    appId = 'checkout-api',
  }: { scenario?: ScenarioKey; appId?: string } = {}) {
    if (!Object.hasOwn(SCENARIOS, scenario))
      throw new Error('Unknown scenario. Choose db-pool, bad-deploy, or latency.');
    if (!this.apps.some((a) => a.id === appId)) throw new Error('Unknown application.');
    if (!['healthy', 'resolved'].includes(this.simulation.phase))
      throw new Error('Resolve or reset the current incident before injecting another.');
    this.simulation = {
      ...this.simulation,
      running: true,
      phase: 'injecting',
      scenario,
      targetAppId: appId,
    };
    this.incidentElapsed = 0;
    this.stages.clear();
    this.messages = [];
    const app = this.apps.find((a) => a.id === appId)!;
    app.status = 'degraded';
    app.version = 'v2.18.0';
    this.event(
      'Failure injected',
      `${this.scenario.label} on ${appId}. Watching for correlated signals.`,
      'warning',
    );
    this.faultLogs();
    return this.state();
  }
  faultLogs() {
    const appId = this.simulation.targetAppId,
      s = this.scenario;
    const httpStatus = s.code === 'DEPLOYMENT_REGRESSION' ? 500 : 503;
    const durationMs =
      s.code === 'DEPLOYMENT_REGRESSION' ? 43 : s.code === 'UPSTREAM_TIMEOUT' ? 5047 : 30000;
    const applicationLog = this.log(appId, 'gcp', 'ERROR', s.error, {
      errorCode: s.code,
      httpStatus,
      durationMs,
      changeId: 'CHG0031842',
    });
    const requestLog = this.log(
      appId,
      'kibana',
      'ERROR',
      `POST /api/v1/${appId.split('-')[0]} ${httpStatus} — ${s.metric}`,
      {
        errorCode: s.code,
        httpStatus,
        durationMs,
      },
    );
    requestLog.traceId = applicationLog.traceId;
    this.log(
      appId,
      'moogsoft',
      this.incidentElapsed >= 5 ? 'ERROR' : 'WARN',
      `Threshold exceeded: ${s.metric}; correlated service=${appId}`,
      {
        relatedTraceId: applicationLog.traceId,
        metric: s.metric,
        dedupKey: `${appId}:${s.code}`,
        eventCount: Math.floor(30 + this.incidentElapsed * 9),
      },
    );
  }
  tick(seconds = 1) {
    if (!this.simulation.running) return this.state();
    const delta = seconds * this.simulation.speed;
    this.simulation.elapsed += delta;
    for (let i = 0; i < Math.min(60, Math.max(1, Math.round(12 * delta))); i++)
      this.backgroundLog();
    if (!['healthy', 'resolved'].includes(this.simulation.phase)) {
      this.incidentElapsed += delta;
      this.faultLogs();
      const stageActions: [number, Phase, () => void][] = [
        [5, 'detected', () => this.detect()],
        [10, 'enriching', () => this.enrich()],
        [16, 'collaborating', () => this.collaborate()],
        [22, 'analyzing', () => this.analyze()],
      ];
      for (const [threshold, name, fn] of stageActions) {
        if (this.incidentElapsed >= threshold && !this.stages.has(name)) {
          this.stages.add(name);
          this.simulation.phase = name;
          fn();
        }
      }
    }
    return this.state();
  }
  detect() {
    const app = this.apps.find((a) => a.id === this.simulation.targetAppId)!;
    app.status = 'critical';
    const evidence = this.logs
      .filter((l) => l.appId === app.id && l.severity === 'ERROR')
      .slice(0, 4)
      .map((l) => l.id);
    this.incidents.unshift({
      id: `INC${String(1042 + this.totalIncidents++).padStart(7, '0')}`,
      title: `${app.id}: ${this.scenario.title}`,
      appId: app.id,
      severity: 'P1',
      status: 'Investigating',
      createdAt: iso(this.now()),
      summary: this.scenario.summary,
      hypothesis: '',
      team: '',
      participants: [],
      evidence,
      timeline: [],
      runbookId: 'RB-042',
      changeId: 'CHG0031842',
    });
    this.incidents = this.incidents.slice(0, 20);
    this.timeline(
      'Anomaly detected',
      'Correlated GCP errors, Kibana request failures, and Moogsoft threshold events.',
    );
    this.event(
      'Incident detected',
      `${this.incident.id} · ${app.id} · P1. Correlated signals from three sources.`,
      'critical',
    );
  }
  enrich() {
    const app = this.apps.find((a) => a.id === this.incident.appId)!;
    this.incident.team = app.team;
    this.incident.participants = this.contacts(app);
    this.timeline(
      'Ownership resolved',
      `ServiceNow CMDB identifies ${app.team}. On-call roster and Confluence runbook RB-042 loaded.`,
    );
    this.event(
      'Owners and runbook found',
      `${app.team} · 4 responders · change CHG0031842 · runbook RB-042`,
      'success',
    );
  }
  collaborate() {
    this.timeline(
      'Teams room created',
      'The simulator created an incident room and added the service owner, on-call engineer, database SRE, and incident commander.',
    );
    this.event(
      'Incident room opened',
      `${this.incident.id} · ${this.incident.participants.map((p) => p.name).join(', ')}`,
      'success',
    );
    this.message(
      'Relay',
      'system',
      `Created ${this.incident.id} and added ${this.incident.participants.map((p) => p.name).join(', ')}.`,
    );
    this.message(
      'Relay agent',
      'agent',
      `P1 incident detected: ${this.incident.title}\n\n${this.incident.summary}\n\nI correlated failures across GCP Cloud Logging, Kibana, and Moogsoft. ${this.incident.team} owns this service according to the ServiceNow CMDB. I invited the on-call engineer, service owner, database SRE, and incident commander.`,
      { kind: 'summary', links: this.evidenceLinks() },
    );
    this.message(
      this.incident.participants[0].name,
      'human',
      'Acknowledged. I’m checking the latest deployment while Relay gathers the evidence.',
    );
  }
  evidenceLinks() {
    const appId = encodeURIComponent(this.simulation.targetAppId);
    const evidenceLog = (source: LogEntry['source']) =>
      this.logs.find((log) => log.source === source && this.incident?.evidence.includes(log.id));
    const exactLogQuery = (source: LogEntry['source']) => {
      const log = evidenceLog(source);
      return log ? `&log=${encodeURIComponent(log.id)}` : '';
    };
    return [
      { label: 'GCP error logs', href: `/gcp?app=${appId}&severity=ERROR${exactLogQuery('gcp')}` },
      {
        label: 'Kibana trace explorer',
        href: `/kibana?app=${appId}&severity=ERROR${exactLogQuery('kibana')}`,
      },
      { label: 'Moogsoft correlation', href: `/moogsoft?app=${appId}` },
      { label: 'Service ownership', href: `/servicenow?app=${appId}` },
      { label: 'Runbook RB-042', href: `/confluence?app=${appId}` },
    ];
  }
  analyze() {
    this.incident.hypothesis = this.scenario.hypothesis;
    this.incident.status = 'Mitigation proposed';
    this.timeline('Likely cause identified', this.scenario.hypothesis);
    this.event(
      'Mitigation proposed',
      'Evidence assembled. A human can review the recommendation and simulate recovery.',
      'success',
    );
    this.message(
      'Relay agent',
      'agent',
      `Likely cause\n${this.scenario.hypothesis}\n\nRecommended next step\n${this.scenario.fix}\n\nThis is a hypothesis from correlated signals. No production changes have been made. Review the evidence before approving a mitigation.`,
      {
        kind: 'analysis',
        links: [
          {
            label: 'Deployment CHG0031842',
            href: `/servicenow?app=${encodeURIComponent(this.incident.appId)}&record=CHG0031842`,
          },
          {
            label: 'Recovery runbook',
            href: `/confluence?app=${encodeURIComponent(this.incident.appId)}`,
          },
        ],
      },
    );
  }
  resolve() {
    if (!this.incident || ['healthy', 'resolved', 'injecting'].includes(this.simulation.phase))
      throw new Error('There is no detected active incident to resolve.');
    this.incident.status = 'Resolved';
    this.incident.resolvedAt = iso(this.now());
    this.simulation.phase = 'resolved';
    const app = this.apps.find((a) => a.id === this.incident.appId)!;
    app.status = 'healthy';
    app.version = 'v2.17.3';
    for (const source of ['gcp', 'kibana', 'moogsoft'] as const)
      this.log(
        app.id,
        source,
        'INFO',
        'RECOVERY: request success=99.98% p99=184ms db.pool.utilization=42%; health check passed',
        { httpStatus: 200, recovered: true },
      );
    this.timeline(
      'Recovery simulated',
      'Mitigation completed in the mock environment. Service health and latency returned to baseline.',
    );
    this.event(
      'Service recovered',
      `${app.id} is healthy. Incident ${this.incident.id} resolved.`,
      'success',
    );
    this.message(
      'Relay agent',
      'agent',
      `Recovery confirmed in the simulation. ${app.id} is healthy again: success rate 99.98%, p99 latency 184ms, and database pool utilization 42%.\n\n${this.incident.id} is resolved. The incident timeline and evidence are retained for review.`,
      { kind: 'summary' },
    );
    return this.state();
  }
  sendMessage(text: unknown) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Message text is required.');
    if (text.length > 4000) throw new Error('Messages must be 4,000 characters or fewer.');
    if (!this.stages.has('collaborating'))
      throw new Error(
        'Inject an incident and wait for the Teams room to open before sending a message.',
      );
    this.message('You', 'human', text.trim());
    let reply;
    if (/rollback|roll back|mitigat|fix|recover/i.test(text))
      reply = `${this.scenario.fix}\n\nUse “Simulate recovery” to apply this only in the mock environment. This chat never changes a real service.`;
    else if (/owner|team|on.call|who/i.test(text))
      reply = `${this.incident.team} owns ${this.incident.appId}. The response team is ${this.incident.participants.map((p) => `${p.name} (${p.role})`).join(', ')}. Ownership comes from the mock ServiceNow CMDB.`;
    else if (/log|trace|evidence|error/i.test(text))
      reply = `The key error is: ${this.scenario.error}. GCP provides the application exception, Kibana provides the failing request trace, and Moogsoft correlates the service alerts. The linked views are filtered to ${this.incident.appId}.`;
    else if (/status|summary|update/i.test(text))
      reply = `${this.incident.id} is ${this.incident.status.toLowerCase()}. ${this.incident.summary} ${this.incident.hypothesis || 'I am still assembling the correlated evidence.'}`;
    else
      reply =
        'I’m the scripted demo agent. Ask me about logs, evidence, ownership, status, or the recommended mitigation. You can inspect each connected mock service through the links below.';
    this.message('Relay agent', 'agent', reply, { links: this.evidenceLinks() });
    return this.state();
  }
  control(input: ControlInput) {
    switch (input.action) {
      case 'start':
        this.simulation.running = true;
        break;
      case 'pause':
        this.simulation.running = false;
        break;
      case 'reset':
        return this.reset();
      case 'inject':
        return this.inject(input);
      case 'resolve':
        return this.resolve();
      case 'speed':
        if (typeof input.speed !== 'number' || ![1, 2, 4].includes(input.speed))
          throw new Error('Speed must be 1, 2, or 4.');
        this.simulation.speed = input.speed;
        break;
      default:
        throw new Error('Unknown control action.');
    }
    return this.state();
  }
  state(): AppState {
    const unhealthy = this.apps.filter((a) => a.status !== 'healthy').length;
    return {
      apps: this.apps,
      logs: this.logs,
      incidents: this.incidents,
      messages: this.messages,
      events: this.events,
      simulation: { ...this.simulation, incidentElapsed: this.incidentElapsed },
      stats: {
        logsPerSecond: this.simulation.running
          ? 12 * this.simulation.speed + (unhealthy ? 3 : 0)
          : 0,
        errorRate: unhealthy
          ? Number(Math.min(24.8, 4.5 + this.incidentElapsed * 0.9).toFixed(1))
          : 0.02,
        healthyApps: this.apps.length - unhealthy,
        totalApps: this.apps.length,
        totalLogs: this.totalLogs,
      },
      generation: this.generation,
    };
  }
  contacts(app: AppRecord) {
    return people
      .map((person) => ({
        ...person,
        role:
          person.name === app.onCall
            ? `Primary on-call · ${app.team}`
            : person.name === app.owner
              ? 'Service owner'
              : person.name ===
                  people.find((p) => p.name !== app.onCall && p.name !== app.owner)?.name
                ? 'Database reliability engineer'
                : 'Incident commander',
      }))
      .sort((a, b) => Number(b.name === app.onCall) - Number(a.name === app.onCall));
  }
  cmdb() {
    return this.apps.map((app) => ({
      ...app,
      contacts: this.contacts(app).map((person) => ({
        ...person,
        email: `${person.name.toLowerCase().replace(' ', '.')}@example.test`,
      })),
      change: {
        id: 'CHG0031842',
        title: `Deploy ${app.id} v2.18.0`,
        status: 'Implemented',
        owner: app.owner,
        risk: 'Moderate',
        description:
          app.id === this.simulation.targetAppId && this.simulation.scenario === 'bad-deploy'
            ? 'Release v2.18.0 introduced settlement-currency payload validation.'
            : app.id === this.simulation.targetAppId && this.simulation.scenario === 'latency'
              ? 'Release v2.18.0 increased upstream retries from one to three.'
              : 'Release v2.18.0; worker concurrency changed from 20 to 80.',
        previousVersion: 'v2.17.3',
        deployedVersion: 'v2.18.0',
      },
      runbookId: 'RB-042',
    }));
  }
  runbooks() {
    return Object.entries(SCENARIOS)
      .sort(
        ([keyA], [keyB]) =>
          Number(keyB === this.simulation.scenario) - Number(keyA === this.simulation.scenario),
      )
      .map(([scenario, data], i) => ({
        id: i ? `RB-04${i + 2}` : 'RB-042',
        title: data.label,
        scenario,
        owner: 'Platform Reliability',
        updatedAt: '2026-11-03T14:20:00.000Z',
        summary: data.summary,
        diagnosis: data.hypothesis,
        steps: data.fix.split('. ').filter(Boolean),
        escalation:
          'Page the service on-call engineer, service owner, and database reliability engineer.',
        verification: 'Success rate >99%, p99 <500ms, and pool utilization <70% for five minutes.',
      }));
  }
}
