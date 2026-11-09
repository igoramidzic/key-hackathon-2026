import type { Rng } from '@sim/world';
import { docTemplates, README_SECTION_KEYS } from '../templates/common';
import {
  BASE_IMAGES,
  DEP_LADDERS,
  EXTRA_TEST_KEYS,
  type Knobs,
  type RepoContext,
} from '../templates/index';

export type ConvType =
  | 'feat'
  | 'fix'
  | 'chore'
  | 'perf'
  | 'refactor'
  | 'docs'
  | 'test'
  | 'ci'
  | 'build';

/** One logical change in seeded history: a knob mutation plus the words describing it. */
export interface Recipe {
  kind: string;
  type: ConvType;
  scope: string;
  /** Lower-case summary, e.g. `increase CIF read timeout to 3000ms`. */
  text: string;
  /** CHANGELOG line (null for tests/docs/ci). */
  changelog: string | null;
  mutate: (k: Knobs) => void;
  labels: string[];
  /** MR description motivation. */
  why: string;
  bullets: string[];
  branch: string;
  /** Release tag created on this commit. */
  tag?: string;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

type Builder = (rng: Rng, ctx: RepoContext, k: Knobs, date: string) => Recipe | null;

const svcLike = (ctx: RepoContext) =>
  ctx.stack === 'java-spring' || ctx.stack === 'node-ts' || ctx.stack === 'python';

function ms(n: number) {
  return `${n}ms`;
}

const dep: Builder = (rng, ctx, k) => {
  const ladder = DEP_LADDERS[ctx.stack];
  const candidates = Object.entries(ladder).filter(
    ([name, versions]) => versions.indexOf(k.deps[name]!) < versions.length - 1,
  );
  if (candidates.length === 0) return null;
  const [name, versions] = rng.pick(candidates);
  const from = k.deps[name]!;
  const idx = versions.indexOf(from);
  const to = versions[Math.min(versions.length - 1, idx + (rng.chance(0.25) ? 2 : 1))]!;
  const security = rng.chance(0.35);
  return {
    kind: 'dep',
    type: rng.chance(0.7) ? 'chore' : 'build',
    scope: 'deps',
    text: `bump ${name} from ${from} to ${to}`,
    changelog: `Upgrade ${name} to ${to}.`,
    mutate: (kk) => {
      kk.deps[name] = to;
    },
    labels: security ? ['dependencies', 'security'] : ['dependencies'],
    why: security
      ? `${name} ${to} addresses a vulnerability flagged by Dependency Scanning.`
      : rng.pick([
          `Routine dependency maintenance: ${name} ${to} is the current supported release.`,
          `${name} ${to} fixes a connection-handling bug we hit in the last load test.`,
          `Keeps us within the platform team's supported version window for ${name}.`,
        ]),
    bullets: [`Bump \`${name}\` ${from} → ${to}`],
    branch: `deps/${slug(name)}-${to}`,
  };
};

const timeout: Builder = (rng, ctx, k) => {
  if (ctx.upstreams.length === 0 || !(svcLike(ctx) || ctx.stack === 'react-web')) return null;
  const u = ctx.stack === 'react-web' ? ctx.upstreams[0]! : rng.pick(ctx.upstreams);
  const t = k.timeouts[u.tla]!;
  const connect = svcLike(ctx) && rng.chance(0.25);
  if (connect) {
    const to = t.connectMs >= 1000 ? 500 : t.connectMs * 2;
    return {
      kind: 'timeout',
      type: 'fix',
      scope: `${u.lower}-client`,
      text: `set ${u.tla} connect timeout to ${ms(to)}`,
      changelog: `${u.appName} (${u.tla}) connect timeout is now ${ms(to)}.`,
      mutate: (kk) => {
        kk.timeouts[u.tla]!.connectMs = to;
      },
      labels: ['backend', 'performance'],
      why:
        to > t.connectMs
          ? `TLS handshakes to ${u.tla} occasionally exceed ${ms(t.connectMs)} after pod restarts.`
          : `Fail fast when ${u.tla} is unreachable instead of tying up worker threads.`,
      bullets: [`\`${u.lower}\` connect timeout ${ms(t.connectMs)} → ${ms(to)}`],
      branch: `${u.lower}-connect-timeout`,
    };
  }
  const increase = t.readMs < 2500 || (t.readMs < 5000 && rng.chance(0.6));
  const to = increase
    ? t.readMs + rng.pick([500, 1000, 1000, 2000])
    : Math.max(1000, t.readMs - 1000);
  return {
    kind: 'timeout',
    type: increase ? 'perf' : 'fix',
    scope: `${u.lower}-client`,
    text: `${increase ? 'increase' : 'reduce'} ${u.tla} read timeout to ${ms(to)}`,
    changelog: `${increase ? 'Increase' : 'Reduce'} ${u.appName} (${u.tla}) read timeout to ${ms(to)}.`,
    mutate: (kk) => {
      kk.timeouts[u.tla]!.readMs = to;
    },
    labels: ['backend', 'performance'],
    why: increase
      ? `p99 latency from ${u.service} reached ~${to - 300}ms during month-end peak and requests were timing out.`
      : `Holding threads for ${ms(t.readMs)} when ${u.tla} is degraded makes our own latency worse; fail fast and let callers retry.`,
    bullets: [`\`${u.lower}\` read timeout ${ms(t.readMs)} → ${ms(to)}`],
    branch: `${u.lower}-read-timeout`,
  };
};

const retries: Builder = (rng, ctx, k) => {
  if (!svcLike(ctx) || ctx.upstreams.length === 0) return null;
  const u = rng.pick(ctx.upstreams);
  const t = k.timeouts[u.tla]!;
  const to = t.retries >= 3 ? 1 : t.retries + 1;
  return {
    kind: 'retries',
    type: 'fix',
    scope: `${u.lower}-client`,
    text:
      to > t.retries
        ? `retry ${u.tla} calls up to ${to} times`
        : `reduce ${u.tla} retries to ${to} to avoid retry storms`,
    changelog: `${u.tla} client retries: ${to}.`,
    mutate: (kk) => {
      kk.timeouts[u.tla]!.retries = to;
    },
    labels: ['backend'],
    why:
      to > t.retries
        ? `Transient 503s from ${u.tla} during their deployments surface to our callers.`
        : `During the last ${u.tla} incident our retries tripled their load. One retry is enough.`,
    bullets: [`\`${u.lower}\` max retries ${t.retries} → ${to}`],
    branch: `${u.lower}-retries`,
  };
};

const pool: Builder = (rng, ctx, k) => {
  if (!svcLike(ctx)) return null;
  const to = rng.pick([20, 25, 50, 75, 100, 150].filter((n) => n !== k.poolSize));
  return {
    kind: 'pool',
    type: 'perf',
    scope: 'http',
    text: `${to > k.poolSize ? 'raise' : 'lower'} HTTP connection pool to ${to}`,
    changelog: `HTTP client connection pool size is now ${to}.`,
    mutate: (kk) => {
      kk.poolSize = to;
    },
    labels: ['performance'],
    why:
      to > k.poolSize
        ? 'Thread dumps during peak show requests waiting on a free upstream connection.'
        : 'Right-size the pool after the move to more replicas; total connections to upstreams were too high.',
    bullets: [`Connection pool ${k.poolSize} → ${to}`],
    branch: 'http-pool-size',
  };
};

const pagesize: Builder = (rng, ctx, k) => {
  if (!svcLike(ctx)) return null;
  const to = rng.pick([50, 100, 200, 250, 500].filter((n) => n !== k.maxPageSize));
  return {
    kind: 'pagesize',
    type: 'fix',
    scope: 'api',
    text: `cap page size at ${to}`,
    changelog: `Maximum page size is now ${to}.`,
    mutate: (kk) => {
      kk.maxPageSize = to;
    },
    labels: ['backend'],
    why:
      to < k.maxPageSize
        ? `Large pages caused GC pauses on ${ctx.repo.name}. The UI never asks for more than ${to}.`
        : `The operations console needs up to ${to} rows per page for exception review.`,
    bullets: [`Max page size ${k.maxPageSize} → ${to}`],
    branch: 'page-size-limit',
  };
};

const cache: Builder = (rng, ctx, k) => {
  if (!(svcLike(ctx) || ctx.stack === 'react-web')) return null;
  const res = ctx.resource.title.toLowerCase();
  if (k.cacheTtlSec === 0) {
    const to = rng.pick([30, 60, 120, 300]);
    return {
      kind: 'cache',
      type: 'feat',
      scope: 'cache',
      text: `cache ${res} lookups for ${to}s`,
      changelog: `Cache ${res} lookups for ${to} seconds.`,
      mutate: (kk) => {
        kk.cacheTtlSec = to;
      },
      labels: ['performance', 'enhancement'],
      why: `Most ${res} reads are repeats within a minute; caching cuts load on the database and upstreams.`,
      bullets: [`Add an in-memory cache with a ${to}s TTL`],
      branch: `${slug(res)}-cache`,
    };
  }
  const disable = rng.chance(0.2);
  const to = disable ? 0 : rng.pick([15, 30, 60, 120].filter((n) => n !== k.cacheTtlSec));
  return {
    kind: 'cache',
    type: 'fix',
    scope: 'cache',
    text: disable
      ? `disable ${res} cache (stale reads after updates)`
      : `set ${res} cache TTL to ${to}s`,
    changelog: disable ? `Remove the ${res} cache.` : `${cap(res)} cache TTL is now ${to}s.`,
    mutate: (kk) => {
      kk.cacheTtlSec = to;
    },
    labels: ['performance'],
    why: disable
      ? 'Customers saw stale data for up to a minute after updates. The cache saved little load.'
      : `Tune the cache TTL after reviewing hit rates in Grafana.`,
    bullets: [disable ? 'Remove the cache' : `Cache TTL ${k.cacheTtlSec}s → ${to}s`],
    branch: `${slug(res)}-cache-ttl`,
  };
};

type FeatureKey = keyof Knobs['features'];

const FEATURE_TEXT: Record<
  FeatureKey,
  { on: [ConvType, string, string]; off: [ConvType, string, string] }
> = {
  retryOnTimeout: {
    on: ['fix', 'client', 'retry idempotent upstream calls on timeout'],
    off: ['refactor', 'client', 'drop client-side retries (handled by the service mesh)'],
  },
  requestIdHeader: {
    on: ['feat', 'observability', 'propagate X-Request-Id to upstream calls'],
    off: ['refactor', 'observability', 'rely on trace headers instead of X-Request-Id'],
  },
  clientMetrics: {
    on: ['feat', 'observability', 'record upstream call latency metrics'],
    off: ['perf', 'observability', 'drop per-call upstream metrics (high cardinality)'],
  },
  problemJson: {
    on: ['refactor', 'api', 'return problem+json for upstream failures'],
    off: ['fix', 'api', 'restore legacy error body for mobile clients'],
  },
  inputValidation: {
    on: ['fix', 'api', 'reject out-of-range page sizes with 400'],
    off: ['fix', 'api', 'clamp page size instead of rejecting the request'],
  },
};

function featureCandidates(ctx: RepoContext): FeatureKey[] {
  const ups = ctx.upstreams.length > 0;
  const api = ctx.repo.kind !== 'batch';
  switch (ctx.stack) {
    case 'java-spring':
      return [
        ...(ups ? (['retryOnTimeout', 'requestIdHeader', 'clientMetrics'] as const) : []),
        ...(api ? (['problemJson', 'inputValidation'] as const) : []),
      ];
    case 'node-ts':
      return [
        'retryOnTimeout',
        'requestIdHeader',
        'clientMetrics',
        ...(api ? (['problemJson', 'inputValidation'] as const) : []),
      ];
    case 'python':
      return [
        ...(ups ? (['retryOnTimeout'] as const) : []),
        'requestIdHeader',
        'problemJson',
        'inputValidation',
      ];
    case 'react-web':
      return ['requestIdHeader'];
    default:
      return [];
  }
}

const feature: Builder = (rng, ctx, k) => {
  const all = featureCandidates(ctx);
  if (all.length === 0) return null;
  const off = all.filter((f) => !k.features[f]);
  const enable = off.length > 0 && (rng.chance(0.85) || off.length === all.length);
  const key = enable ? rng.pick(off) : rng.pick(all.filter((f) => k.features[f]));
  const [type, scope, text] = FEATURE_TEXT[key][enable ? 'on' : 'off'];
  return {
    kind: 'feature',
    type,
    scope,
    text,
    changelog: `${cap(text)}.`,
    mutate: (kk) => {
      kk.features[key] = enable;
    },
    labels: type === 'feat' ? ['enhancement'] : type === 'fix' ? ['bug'] : ['tech-debt'],
    why: rng.pick([
      'Came out of the last incident review action items.',
      'Requested by the platform team as part of the observability standards.',
      `Aligns ${ctx.repo.name} with the other ${ctx.app.businessUnit} services.`,
    ]),
    bullets: [cap(text)],
    branch: slug(text),
  };
};

const loglevel: Builder = (rng, ctx, k) => {
  if (!svcLike(ctx)) return null;
  const to: Knobs['logLevel'] =
    k.logLevel === 'INFO' ? (rng.chance(0.6) ? 'WARN' : 'DEBUG') : 'INFO';
  const text =
    to === 'WARN'
      ? `reduce log noise: ${ctx.tlaLower} log level WARN`
      : to === 'DEBUG'
        ? `enable DEBUG logging for ${ctx.tlaLower} packages`
        : `restore INFO log level`;
  return {
    kind: 'loglevel',
    type: 'chore',
    scope: 'logging',
    text,
    changelog: null,
    mutate: (kk) => {
      kk.logLevel = to;
    },
    labels: ['observability'],
    why:
      to === 'WARN'
        ? 'Log volume from this service was ~40% of the namespace ingestion bill.'
        : to === 'DEBUG'
          ? 'Temporary: we need request-level detail to reproduce an intermittent failure.'
          : 'Investigation complete; go back to the default level.',
    bullets: [`Log level ${k.logLevel} → ${to}`],
    branch: 'log-level',
  };
};

const TEST_TEXT: Record<string, string> = {
  validation: 'request validation',
  'client-timeouts': 'upstream client timeout',
  'error-mapping': 'error mapping',
  serialization: 'serialization',
};

const test: Builder = (rng, ctx, k) => {
  const keys = (EXTRA_TEST_KEYS[ctx.stack] ?? []).filter(
    (key) => !k.extraTests.includes(key) && (key !== 'client-timeouts' || ctx.upstreams.length > 0),
  );
  if (keys.length === 0) return null;
  const key = rng.pick(keys);
  const text = `add ${TEST_TEXT[key] ?? key} tests`;
  return {
    kind: 'test',
    type: 'test',
    scope: ctx.resource.kebab,
    text,
    changelog: null,
    mutate: (kk) => {
      kk.extraTests.push(key);
    },
    labels: ['testing'],
    why: 'Coverage gap found while reviewing the last incident.',
    bullets: [cap(text)],
    branch: slug(text),
  };
};

const docs: Builder = (rng, ctx, k) => {
  const allowed =
    ctx.stack === 'terraform' || ctx.stack === 'react-web' ? ['runbook', 'dr'] : undefined;
  const pool = docTemplates(ctx).filter(
    (d) => (!allowed || allowed.includes(d.key)) && !k.docs.some((x) => x.path === d.path),
  );
  if (pool.length === 0) return null;
  const doc = rng.pick(pool);
  return {
    kind: 'docs',
    type: 'docs',
    scope: '',
    text: `add ${doc.title.replace(/^ADR-\d+: /, 'ADR for ').toLowerCase()}`,
    changelog: null,
    mutate: (kk) => {
      kk.docs.push({ path: doc.path, title: doc.title, body: doc.body });
    },
    labels: ['documentation'],
    why: 'Requested in the last operational readiness review.',
    bullets: [`Add \`${doc.path}\``, 'Link it from the README'],
    branch: `docs-${doc.key}`,
  };
};

const CI_TEXT: Record<keyof Knobs['ci'], string> = {
  sast: 'enable SAST scanning',
  dependencyScanning: 'add dependency scanning',
  cache: 'cache build dependencies between pipelines',
  coverage: 'publish test coverage report',
};

const ci: Builder = (rng, ctx, k) => {
  const off = (Object.keys(k.ci) as (keyof Knobs['ci'])[]).filter(
    (key) =>
      !k.ci[key] && (ctx.stack !== 'terraform' || key === 'sast' || key === 'dependencyScanning'),
  );
  if (off.length === 0) return null;
  const key = rng.pick(off);
  return {
    kind: 'ci',
    type: 'ci',
    scope: '',
    text: CI_TEXT[key],
    changelog: null,
    mutate: (kk) => {
      kk.ci[key] = true;
    },
    labels: ['ci'],
    why:
      key === 'cache'
        ? 'Pipelines spend ~3 minutes downloading dependencies on every run.'
        : 'Required by the 2024 secure SDLC standard (InfoSec control SDLC-07).',
    bullets: [cap(CI_TEXT[key])],
    branch: `ci-${slug(key)}`,
  };
};

const docker: Builder = (_rng, ctx, k) => {
  if (ctx.stack === 'terraform') return null;
  const { image, tags } = BASE_IMAGES[ctx.stack];
  const idx = tags.indexOf(k.baseImage);
  if (idx < 0 || idx >= tags.length - 1) return null;
  const to = tags[idx + 1]!;
  return {
    kind: 'docker',
    type: 'build',
    scope: 'docker',
    text: `bump base image to ${image}:${to}`,
    changelog: `Update base image to ${image}:${to}.`,
    mutate: (kk) => {
      kk.baseImage = to;
    },
    labels: ['security', 'dependencies'],
    why: 'Container scanning reported OS package CVEs in the current base image.',
    bullets: [`\`${image}:${k.baseImage}\` → \`${image}:${to}\``],
    branch: `base-image-${slug(to)}`,
  };
};

function nextVersion(version: string, minor: boolean): string {
  const [maj, min, pat] = version.split('.').map((n) => Number(n) || 0);
  return minor ? `${maj}.${(min ?? 0) + 1}.0` : `${maj}.${min}.${(pat ?? 0) + 1}`;
}

const release: Builder = (rng, _ctx, k, date) => {
  const to = nextVersion(k.version, rng.chance(0.35));
  return {
    kind: 'release',
    type: 'chore',
    scope: 'release',
    text: `release ${to}`,
    changelog: null,
    mutate: (kk) => {
      kk.version = to;
      kk.changelog.releases.push({
        version: to,
        date,
        entries:
          kk.changelog.unreleased.length > 0
            ? [...kk.changelog.unreleased]
            : ['Maintenance release.'],
      });
      kk.changelog.unreleased = [];
    },
    labels: ['release'],
    why: `Cut ${to} for the next production change window.`,
    bullets: [`Version ${k.version} → ${to}`, 'Move Unreleased entries under the new version'],
    branch: `release-${to}`,
    tag: `v${to}`,
  };
};

const README_TEXT: Record<string, string> = {
  troubleshooting: 'document troubleshooting steps',
  oncall: 'document on-call escalation',
  'release-process': 'document the release process',
  observability: 'document dashboards and alerts',
};

const readmeRecipe: Builder = (rng, _ctx, k) => {
  const pool = README_SECTION_KEYS.filter((s) => !k.readmeSections.includes(s));
  if (pool.length === 0) return null;
  const key = rng.pick(pool);
  return {
    kind: 'readme',
    type: 'docs',
    scope: 'readme',
    text: README_TEXT[key] ?? `document ${key}`,
    changelog: null,
    mutate: (kk) => {
      kk.readmeSections.push(key);
    },
    labels: ['documentation'],
    why: 'New team members kept asking about this in the channel.',
    bullets: ['Update README'],
    branch: `readme-${key}`,
  };
};

const IGNORES = ['*.swp', 'local.env', '*.orig', 'tmp/', '.envrc', 'out/'];

const gitignoreRecipe: Builder = (rng, _ctx, k) => {
  const pool = IGNORES.filter((x) => !k.gitignoreExtra.includes(x));
  if (pool.length === 0) return null;
  const entry = rng.pick(pool);
  return {
    kind: 'gitignore',
    type: 'chore',
    scope: '',
    text: `ignore ${entry}`,
    changelog: null,
    mutate: (kk) => {
      kk.gitignoreExtra.push(entry);
    },
    labels: [],
    why: 'Local files kept showing up in `git status`.',
    bullets: [`Add \`${entry}\` to .gitignore`],
    branch: 'gitignore',
  };
};

const infraScale: Builder = (rng, ctx, k) => {
  if (ctx.stack !== 'terraform') return null;
  const min = rng.pick([2, 3, 4, 6].filter((n) => n !== k.infra.minReplicas));
  const max = Math.max(min * 2, k.infra.maxReplicas);
  return {
    kind: 'infra-scale',
    type: 'perf',
    scope: 'gke',
    text: `scale ${ctx.app.runtime.service} to ${min}-${max} replicas`,
    changelog: `Run ${min}-${max} replicas in production.`,
    mutate: (kk) => {
      kk.infra.minReplicas = min;
      kk.infra.maxReplicas = max;
    },
    labels: ['infrastructure'],
    why:
      min > k.infra.minReplicas
        ? 'HPA scale-up lags the 8am traffic ramp; keep more warm replicas.'
        : 'Overnight utilisation is under 10%; reduce the floor.',
    bullets: [`min replicas ${k.infra.minReplicas} → ${min}`, `max replicas → ${max}`],
    branch: 'gke-replicas',
  };
};

const infraDb: Builder = (rng, ctx, k) => {
  if (ctx.stack !== 'terraform') return null;
  if (rng.chance(0.5)) {
    const to = rng.pick(
      ['db-custom-2-7680', 'db-custom-4-15360', 'db-custom-8-30720'].filter(
        (t) => t !== k.infra.dbTier,
      ),
    );
    return {
      kind: 'infra-db',
      type: 'perf',
      scope: 'cloudsql',
      text: `move Cloud SQL to ${to}`,
      changelog: `Cloud SQL tier ${to}.`,
      mutate: (kk) => {
        kk.infra.dbTier = to;
      },
      labels: ['infrastructure'],
      why: 'CPU on the primary instance is consistently above 70% during batch windows.',
      bullets: [`db tier ${k.infra.dbTier} → ${to}`],
      branch: 'cloudsql-tier',
    };
  }
  const to = rng.pick([7, 14, 30, 35].filter((n) => n !== k.infra.backupRetentionDays));
  return {
    kind: 'infra-db',
    type: 'chore',
    scope: 'cloudsql',
    text: `keep ${to} days of database backups`,
    changelog: `Retain ${to} days of Cloud SQL backups.`,
    mutate: (kk) => {
      kk.infra.backupRetentionDays = to;
    },
    labels: ['infrastructure', 'compliance'],
    why: 'Aligns with the records retention standard.',
    bullets: [`backup retention ${k.infra.backupRetentionDays} → ${to} days`],
    branch: 'cloudsql-backups',
  };
};

const BUILDERS: [Builder, number][] = [
  [dep, 18],
  [timeout, 8],
  [retries, 4],
  [pool, 3],
  [pagesize, 3],
  [cache, 4],
  [feature, 8],
  [loglevel, 3],
  [test, 7],
  [docs, 5],
  [ci, 4],
  [docker, 5],
  [release, 9],
  [readmeRecipe, 3],
  [gitignoreRecipe, 1],
  [infraScale, 12],
  [infraDb, 8],
];

/**
 * Picks a recipe applicable to the repo's current knob state. `accept` lets the planner veto a
 * recipe (e.g. one that would touch a protected overlay file); it is retried with another kind.
 */
export function pickRecipe(
  rng: Rng,
  ctx: RepoContext,
  k: Knobs,
  date: string,
  accept: (r: Recipe) => boolean = () => true,
  exclude: string[] = [],
): Recipe | null {
  let pool = BUILDERS.filter(([b]) => !exclude.includes(b.name));
  for (let attempt = 0; attempt < 12 && pool.length > 0; attempt++) {
    const builder = rng.weighted(pool);
    const recipe = builder(rng, ctx, k, date);
    if (recipe && accept(recipe)) return recipe;
    pool = pool.filter(([b]) => b !== builder);
  }
  return null;
}
