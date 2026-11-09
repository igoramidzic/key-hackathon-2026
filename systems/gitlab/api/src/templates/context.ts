import type { App, Person, Repo, Stack } from '@sim/world';
import { getWorld, Rng } from '@sim/world';

/** Name variants for one identifier (`customer-profile`). */
export interface Names {
  kebab: string;
  pascal: string;
  camel: string;
  snake: string;
  title: string;
  /** Plural kebab for REST paths (`customer-profiles`). */
  pluralKebab: string;
}

export function names(input: string): Names {
  const words = input
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  const pascal = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');
  const last = words[words.length - 1] ?? '';
  const pluralLast = last.endsWith('s')
    ? last
    : last.endsWith('y') && !/[aeiou]y$/.test(last)
      ? `${last.slice(0, -1)}ies`
      : `${last}s`;
  return {
    kebab: words.join('-'),
    pascal,
    camel: pascal[0]!.toLowerCase() + pascal.slice(1),
    snake: words.join('_'),
    title: words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' '),
    pluralKebab: [...words.slice(0, -1), pluralLast].join('-'),
  };
}

const STRIP_SUFFIXES = new Set([
  'api',
  'service',
  'svc',
  'web',
  'batch',
  'infra',
  'bff',
  'gateway',
  'engine',
  'hub',
  'portal',
  'adapter',
  'orchestrator',
  'console',
  'workbench',
  'scheduler',
  'monitor',
  'calculator',
  'exchange',
  'archive',
  'notifications',
  'reconciliation',
  'reporting',
  'analytics',
  'ledger',
  'mart',
  'data',
  'processor',
  'feed',
  'rules',
  'app',
]);

function singular(word: string): string {
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('ss') || word.endsWith('us')) return word;
  if (word.endsWith('s') && word.length > 3) return word.slice(0, -1);
  return word;
}

/** Domain resource for a repo: `customer-profile-api` → CustomerProfile. */
export function resourceFor(repoName: string): Names {
  const tokens = repoName.split('-').filter(Boolean);
  while (tokens.length > 1 && STRIP_SUFFIXES.has(tokens[tokens.length - 1]!)) tokens.pop();
  tokens[tokens.length - 1] = singular(tokens[tokens.length - 1]!);
  return names(tokens.join('-'));
}

/** One call this service makes to an upstream app. */
export interface UpstreamOp {
  method: string;
  verb: 'GET' | 'POST';
  /** `{id}` marks the path parameter for GETs. */
  path: string;
  arg: string;
  model: string;
  summary: string;
}

const HERO_OPS: Record<string, UpstreamOp> = {
  ATH: {
    method: 'introspectToken',
    verb: 'POST',
    path: '/oauth2/introspect',
    arg: 'token',
    model: 'TokenInfo',
    summary: 'Validate the caller access token',
  },
  CIF: {
    method: 'getCustomer',
    verb: 'GET',
    path: '/api/v1/customers/{id}',
    arg: 'customerId',
    model: 'CustomerProfile',
    summary: 'Load the customer profile',
  },
  DEP: {
    method: 'getAccount',
    verb: 'GET',
    path: '/api/v1/accounts/{id}',
    arg: 'accountId',
    model: 'Account',
    summary: 'Load the deposit account and available balance',
  },
  GLD: {
    method: 'postJournalEntry',
    verb: 'POST',
    path: '/api/v1/journal-entries',
    arg: 'entry',
    model: 'JournalReceipt',
    summary: 'Post the ledger entry',
  },
  NTF: {
    method: 'sendNotification',
    verb: 'POST',
    path: '/api/v1/notifications',
    arg: 'notification',
    model: 'NotificationReceipt',
    summary: 'Notify the customer',
  },
  FRD: {
    method: 'scoreTransaction',
    verb: 'POST',
    path: '/api/v1/score',
    arg: 'request',
    model: 'FraudScore',
    summary: 'Score the transaction for fraud risk',
  },
  ABA: {
    method: 'lookupRoutingNumber',
    verb: 'GET',
    path: '/api/v1/routing-numbers/{id}',
    arg: 'routingNumber',
    model: 'Institution',
    summary: 'Resolve the receiving institution',
  },
  ACH: {
    method: 'submitEntry',
    verb: 'POST',
    path: '/api/v1/entries',
    arg: 'entry',
    model: 'AchEntryReceipt',
    summary: 'Submit the ACH entry for origination',
  },
  WIR: {
    method: 'createWire',
    verb: 'POST',
    path: '/api/v1/wires',
    arg: 'wire',
    model: 'WireReceipt',
    summary: 'Originate the wire transfer',
  },
  PAY: {
    method: 'getPayment',
    verb: 'GET',
    path: '/api/v1/payments/{id}',
    arg: 'paymentId',
    model: 'Payment',
    summary: 'Load the payment',
  },
  BPY: {
    method: 'getPayee',
    verb: 'GET',
    path: '/api/v1/payees/{id}',
    arg: 'payeeId',
    model: 'Payee',
    summary: 'Load the bill pay payee',
  },
  CRD: {
    method: 'getCard',
    verb: 'GET',
    path: '/api/v1/cards/{id}',
    arg: 'cardId',
    model: 'Card',
    summary: 'Load card status and controls',
  },
};

export interface UpstreamInfo {
  tla: string;
  lower: string;
  /** `Cif` — used for class names (`CifClient`). */
  pascal: string;
  appName: string;
  service: string;
  baseUrl: string;
  /** `CIF_BASE_URL` */
  envVar: string;
  /** GitLab path of the upstream's primary repo. */
  repoPath: string;
  op: UpstreamOp;
}

function upstreamInfo(app: App): UpstreamInfo {
  const service = app.runtime.service;
  const resource = resourceFor(service);
  const op: UpstreamOp = HERO_OPS[app.tla] ?? {
    method: `get${resource.pascal}`,
    verb: 'GET',
    path: `/api/v1/${resource.pluralKebab}/{id}`,
    arg: `${resource.camel}Id`,
    model: resource.pascal,
    summary: `Load the ${resource.title.toLowerCase()}`,
  };
  return {
    tla: app.tla,
    lower: app.tla.toLowerCase(),
    pascal: app.tla[0] + app.tla.slice(1).toLowerCase(),
    appName: app.name,
    service,
    baseUrl: `http://${service}.${app.tla.toLowerCase()}00.svc.cluster.local:8080`,
    envVar: `${app.tla}_BASE_URL`,
    repoPath: app.repoPaths[0]!,
    op,
  };
}

export interface RepoContext {
  repo: Repo;
  app: App;
  stack: Stack;
  tla: string;
  tlaLower: string;
  /** Java package root: `com.keybank.pay`. */
  javaPackage: string;
  /** Python package: `payments_api`. */
  pyPackage: string;
  /** Repo name variants (`payments-api` → PaymentsApi). */
  repoNames: Names;
  resource: Names;
  /** Upstream calls made by this repo's code. */
  upstreams: UpstreamInfo[];
  owner: Person | undefined;
  developers: Person[];
  supportGroupName: string;
  /** Domain-flavoured extra field for the resource model. */
  amountField: boolean;
}

export function buildContext(repo: Repo): RepoContext {
  const world = getWorld();
  const app = world.appsByTla.get(repo.tla)!;
  const upstreamApps = app.upstream
    .map((t) => world.appsByTla.get(t))
    .filter((a): a is App => Boolean(a));
  let upstreams: UpstreamInfo[] = [];
  if (repo.kind === 'service') upstreams = upstreamApps.map(upstreamInfo);
  else if (repo.kind === 'batch') upstreams = upstreamApps.slice(0, 3).map(upstreamInfo);
  else if (repo.kind === 'web') {
    const own = upstreamInfo(app);
    const primary = world.reposByPath.get(app.repoPaths[0]!);
    const list = primary && primary.kind === 'service' ? [own] : [];
    const ath = world.appsByTla.get('ATH');
    if (ath && app.tla !== 'ATH') list.push(upstreamInfo(ath));
    upstreams = list;
  }
  const tlaLower = repo.tla.toLowerCase();
  const group = world.groupsById.get(app.supportGroupId);
  return {
    repo,
    app,
    stack: repo.stack,
    tla: repo.tla,
    tlaLower,
    javaPackage: `com.keybank.${tlaLower}`,
    pyPackage: repo.name.replace(/-/g, '_'),
    repoNames: names(repo.name),
    resource: resourceFor(repo.name),
    upstreams,
    owner: world.peopleByUsername.get(app.ownerUsername),
    developers: app.developerUsernames
      .map((u) => world.peopleByUsername.get(u))
      .filter((p): p is Person => Boolean(p)),
    supportGroupName: group?.name ?? `${app.tla} Application Support`,
    amountField: ['Payments', 'Cards', 'Consumer Lending', 'Commercial Banking'].includes(
      app.businessUnit,
    ),
  };
}

// ---------------------------------------------------------------------------
// Knobs: every generated file is a pure function of (context, knobs). Seeded history mutates
// knobs and re-renders, so each seeded commit is a small, real diff.
// ---------------------------------------------------------------------------

export interface UpstreamKnobs {
  connectMs: number;
  readMs: number;
  retries: number;
}

export interface DocKnob {
  path: string;
  title: string;
  body: string;
}

export interface ChangelogRelease {
  version: string;
  date: string;
  entries: string[];
}

export interface Knobs {
  version: string;
  deps: Record<string, string>;
  baseImage: string;
  timeouts: Record<string, UpstreamKnobs>;
  poolSize: number;
  cacheTtlSec: number;
  maxPageSize: number;
  logLevel: 'INFO' | 'DEBUG' | 'WARN';
  features: {
    retryOnTimeout: boolean;
    problemJson: boolean;
    requestIdHeader: boolean;
    inputValidation: boolean;
    clientMetrics: boolean;
  };
  ci: { sast: boolean; dependencyScanning: boolean; cache: boolean; coverage: boolean };
  extraTests: string[];
  docs: DocKnob[];
  readmeSections: string[];
  changelog: { unreleased: string[]; releases: ChangelogRelease[] };
  infra: {
    minReplicas: number;
    maxReplicas: number;
    cpu: string;
    memory: string;
    dbTier: string;
    backupRetentionDays: number;
  };
  /** Free-form lines appended to `.gitignore`. */
  gitignoreExtra: string[];
}

/** Version ladders per stack: seeded history bumps a dependency to its next rung. */
export const DEP_LADDERS: Record<Stack, Record<string, string[]>> = {
  'java-spring': {
    'spring-boot': [
      '3.2.5',
      '3.2.8',
      '3.3.1',
      '3.3.4',
      '3.3.6',
      '3.4.1',
      '3.4.3',
      '3.4.5',
      '3.5.0',
      '3.5.3',
    ],
    resilience4j: ['2.1.0', '2.2.0', '2.3.0'],
    'logstash-logback-encoder': ['7.4', '8.0', '8.1'],
    wiremock: ['3.5.4', '3.9.1', '3.10.0', '3.12.1'],
    jacoco: ['0.8.11', '0.8.12', '0.8.13'],
  },
  'node-ts': {
    fastify: ['4.26.2', '4.27.0', '4.28.1', '4.29.0'],
    zod: ['3.22.4', '3.23.8', '3.24.1', '3.24.2'],
    pino: ['8.19.0', '9.1.0', '9.4.0', '9.6.0'],
    typescript: ['5.4.5', '5.5.4', '5.6.3', '5.7.3'],
    vitest: ['1.6.0', '2.0.5', '2.1.8', '3.0.5'],
    tsx: ['4.7.2', '4.16.2', '4.19.2'],
  },
  python: {
    fastapi: ['0.110.3', '0.111.1', '0.112.2', '0.114.2', '0.115.6'],
    httpx: ['0.27.0', '0.27.2', '0.28.1'],
    'pydantic-settings': ['2.2.1', '2.4.0', '2.6.1', '2.7.1'],
    uvicorn: ['0.29.0', '0.30.6', '0.32.1', '0.34.0'],
    structlog: ['24.1.0', '24.4.0', '25.1.0'],
    pytest: ['8.1.1', '8.2.2', '8.3.4'],
  },
  'react-web': {
    react: ['18.2.0', '18.3.1'],
    'react-router-dom': ['6.22.3', '6.23.1', '6.26.2', '6.28.0'],
    '@tanstack/react-query': ['5.28.9', '5.45.1', '5.59.20', '5.62.8'],
    vite: ['5.2.8', '5.3.5', '5.4.11', '6.0.7'],
    typescript: ['5.4.5', '5.5.4', '5.6.3', '5.7.3'],
    vitest: ['1.6.0', '2.0.5', '2.1.8'],
  },
  terraform: {
    google: ['5.25.0', '5.40.0', '5.44.2', '6.8.0', '6.14.1', '6.17.0'],
  },
};

export const BASE_IMAGES: Record<Stack, { image: string; tags: string[] }> = {
  'java-spring': {
    image: 'eclipse-temurin',
    tags: [
      '21.0.2_13-jre-jammy',
      '21.0.3_9-jre-jammy',
      '21.0.4_7-jre-jammy',
      '21.0.5_11-jre-jammy',
      '21.0.6_7-jre-jammy',
    ],
  },
  'node-ts': {
    image: 'node',
    tags: ['20.12.2-alpine3.19', '20.15.1-alpine3.20', '20.17.0-alpine3.20', '20.18.1-alpine3.21'],
  },
  python: { image: 'python', tags: ['3.12.3-slim', '3.12.5-slim', '3.12.7-slim', '3.12.8-slim'] },
  'react-web': {
    image: 'nginx',
    tags: ['1.25.4-alpine', '1.26.1-alpine', '1.27.2-alpine', '1.27.3-alpine'],
  },
  terraform: { image: 'hashicorp/terraform', tags: ['1.7.5', '1.8.5', '1.9.8', '1.10.3'] },
};

/** `createdDate` (YYYY-MM-DD) dates the initial release in the CHANGELOG. */
export function initialKnobs(ctx: RepoContext, createdDate: string): Knobs {
  const rng = new Rng(`knobs:${ctx.repo.path}`);
  const version = `${rng.int(1, 3)}.${rng.int(0, 24)}.${rng.int(0, 9)}`;
  const ladder = DEP_LADDERS[ctx.stack];
  const deps: Record<string, string> = {};
  for (const [name, versions] of Object.entries(ladder)) {
    deps[name] = versions[rng.int(0, Math.floor((versions.length - 1) / 2))]!;
  }
  const images = BASE_IMAGES[ctx.stack].tags;
  const timeouts: Record<string, UpstreamKnobs> = {};
  for (const up of ctx.upstreams) {
    timeouts[up.tla] = {
      connectMs: rng.pick([250, 500, 500, 1000]),
      readMs: rng.pick([1500, 2000, 2000, 2500, 3000, 5000]),
      retries: rng.pick([1, 2, 2, 3]),
    };
  }
  return {
    version,
    deps,
    baseImage: images[rng.int(0, Math.floor((images.length - 1) / 2))]!,
    timeouts,
    poolSize: rng.pick([20, 25, 50, 50, 100]),
    cacheTtlSec: rng.chance(0.3) ? rng.pick([30, 60, 300]) : 0,
    maxPageSize: rng.pick([100, 200, 250, 500]),
    logLevel: 'INFO',
    features: {
      retryOnTimeout: rng.chance(0.4),
      problemJson: rng.chance(0.5),
      requestIdHeader: rng.chance(0.6),
      inputValidation: rng.chance(0.6),
      clientMetrics: rng.chance(0.4),
    },
    ci: {
      sast: rng.chance(0.6),
      dependencyScanning: rng.chance(0.4),
      cache: rng.chance(0.5),
      coverage: rng.chance(0.5),
    },
    extraTests: [],
    docs: [],
    readmeSections: [],
    changelog: {
      unreleased: [],
      releases: [
        {
          version,
          date: createdDate,
          entries: [`Initial release of ${ctx.repo.name}.`],
        },
      ],
    },
    infra: {
      minReplicas: rng.pick([2, 2, 3, 4]),
      maxReplicas: rng.pick([6, 8, 10, 12]),
      cpu: rng.pick(['500m', '1', '1', '2']),
      memory: rng.pick(['512Mi', '1Gi', '1Gi', '2Gi']),
      dbTier: rng.pick(['db-custom-2-7680', 'db-custom-4-15360', 'db-custom-2-7680']),
      backupRetentionDays: rng.pick([7, 14, 30]),
    },
    gitignoreExtra: [],
  };
}

export function cloneKnobs(k: Knobs): Knobs {
  return structuredClone(k);
}

/** Markdown code fence (avoids escaping backticks inside templates). */
export const FENCE = '```';

/** Joins template lines, dropping `null`/`false` entries (for conditional lines). */
export function lines(...parts: (string | null | false | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === 'string').join('\n');
}

export function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((l) => (l ? pad + l : l))
    .join('\n');
}

export const javaPath = (ctx: RepoContext, sub: string, test = false) =>
  `src/${test ? 'test' : 'main'}/java/${ctx.javaPackage.replace(/\./g, '/')}/${sub}`;
