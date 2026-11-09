import { getApp } from '@sim/world';
import {
  internalUrl,
  javaLog,
  javaPackage,
  nodeLog,
  perStack,
  pyLog,
  pyPackage,
  springJwtExpired,
} from '../logs';
import {
  ATH_BAD_EXPIRES_LINE,
  ATH_CONFIG_UNIFIED,
  ATH_CONFIG_YAML,
  ATH_PATHS,
  ATH_REPO,
  ATH_TOKEN_SERVICE_BAD,
  ATH_TOKEN_SERVICE_TEST_BAD,
} from '../repos/ath';
import { CIF_REPO } from '../repos/cif';
import { MBL_AUTH_PLUGIN, MBL_PATHS } from '../repos/mbl';
import { OLB_AUTH_CLIENT, OLB_PATHS } from '../repos/olb';
import { TLR_CONTROLLER, TLR_GL_CLIENT, TLR_TRANSACTION_SERVICE } from '../repos/tlr';
import type { ScenarioDefinition } from '../types';
import {
  dev,
  javaFrame,
  javaStack,
  latency,
  lineOf,
  moogsoftAlert,
  NODE_TICKS,
  nodeFrame,
  paymentId,
  pos,
  springMvcFrames,
  springProxyFrames,
  stripCComments,
  stripHashComments,
  tpl,
  uuid,
} from '../util';

// ---------------------------------------------------------------------------
// Fix detection: compute the effective access-token lifetime in seconds
// ---------------------------------------------------------------------------

const CONVERTS_MINUTES =
  /\*\s*\(?\s*60\b|\b60\s*\*|SECONDS_PER_MINUTE|minutesToSeconds|toSeconds\(/;
const toNumber = (raw: string) => Number(raw.replace(/_/g, ''));

/**
 * Follows `const expiresIn = ...` in tokenService.ts through src/config.ts (env default or YAML
 * value) and applies any minutes-to-seconds conversion on the way. Null when it can't tell.
 */
export function athAccessTokenTtlSec(files: Record<string, string | null>): number | null {
  const svc = stripCComments(files[ATH_PATHS.tokenService] ?? '');
  const cfg = stripCComments(files[ATH_PATHS.config] ?? '');
  const yaml = stripHashComments(files[ATH_PATHS.configYaml] ?? '');

  const svcLine = svc.split('\n').find((l) => /\bconst expiresIn\s*=/.test(l));
  if (!svcLine) return null;

  let ttl: number;
  const key = svcLine.match(/config\.tokens\.(\w+)/)?.[1];
  const literal = svcLine.match(/=\s*([\d_]+)\s*(?:[;*]|$)/);
  if (key) {
    const cfgLine = cfg.split('\n').find((l) => new RegExp(`^\\s*${key}\\s*:`).test(l));
    if (!cfgLine) return null;
    const envDefault = cfgLine.match(/,\s*([\d_]+)\s*\)/);
    const bare = cfgLine.match(/:\s*([\d_]+)\s*,?\s*$/);
    const yamlKey = cfgLine.match(/file\.tokens\.(\w+)/)?.[1];
    if (envDefault) ttl = toNumber(envDefault[1]!);
    else if (bare) ttl = toNumber(bare[1]!);
    else if (yamlKey) {
      const fromYaml = yaml.match(new RegExp(`^\\s*${yamlKey}\\s*:\\s*(\\d+)`, 'm'));
      if (!fromYaml) return null;
      ttl = Number(fromYaml[1]);
    } else return null;
    if (CONVERTS_MINUTES.test(cfgLine)) ttl *= 60;
  } else if (literal) {
    ttl = toNumber(literal[1]!);
  } else {
    return null;
  }
  if (CONVERTS_MINUTES.test(svcLine)) ttl *= 60;
  return ttl;
}

function athIsFixed(files: Record<string, string | null>): boolean {
  const ttl = athAccessTokenTtlSec(files);
  if (ttl === null) return !(files[ATH_PATHS.tokenService] ?? '').includes(ATH_BAD_EXPIRES_LINE);
  return ttl >= 300 && ttl <= 3600;
}

const BAD_TEST_BLOCK = ATH_TOKEN_SERVICE_TEST_BAD.slice(
  ATH_TOKEN_SERVICE_TEST_BAD.indexOf("  it('issues access tokens with the configured lifetime'"),
  ATH_TOKEN_SERVICE_TEST_BAD.indexOf("    expect(claims.azp).toBe('pay-api');"),
);

const FIXED_TEST_BLOCK = `  it('issues 15 minute access tokens (config minutes, expires_in seconds)', async () => {
    const res = await tokens.issue({ clientId: 'pay-api', scopes: ['cif.read', 'dep.read'] });

    expect(res.token_type).toBe('Bearer');
    expect(res.expires_in).toBe(config.tokens.accessTokenTtl * 60);
    expect(res.expires_in).toBe(900);
    const claims = decodeJwt(res.access_token);
    expect(claims.exp! - claims.iat!).toBe(900);
`;

// ---------------------------------------------------------------------------
// Log templates
// ---------------------------------------------------------------------------

const TOKEN_CLIENTS: (readonly [readonly [string, string, string], number])[] = [
  [['olb-bff', 'refresh_token', 'openid accounts payments profile'], 6],
  [['mobile-app-ios', 'refresh_token', 'openid accounts payments cards'], 1],
  [['mobile-app-android', 'refresh_token', 'openid accounts payments cards'], 1],
  [['pay-api', 'client_credentials', 'cif.read dep.read dep.write ach.submit wire.submit'], 2],
  [['crd-api', 'client_credentials', 'cif.read'], 1],
  [['tlr-api', 'client_credentials', 'cif.read dep.read dep.write gl.post'], 1],
  [['ntf-service', 'client_credentials', 'cif.read'], 1],
  [['fraud-engine', 'client_credentials', 'cif.read'], 1],
];

const TOKEN_URL = 'https://auth.internal.keybank.example/oauth2/token';

const OLB_REFRESH_THROW = pos(
  OLB_AUTH_CLIENT,
  'throw new TokenRefreshError(',
  'new TokenRefreshError(',
);
const MBL_VERIFY = pos(MBL_AUTH_PLUGIN, 'const { payload } = await jwtVerify(', 'jwtVerify(');

const expiredAt = (now: Date, agoSec: number) =>
  new Date(now.getTime() - agoSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

function tlrGlUnauthorizedStack(): string {
  return javaStack({
    type: 'org.springframework.web.client.HttpClientErrorException$Unauthorized',
    message: '401 Unauthorized: [no body]',
    frames: [
      'org.springframework.web.client.HttpClientErrorException.create(HttpClientErrorException.java:106)',
      'org.springframework.web.client.StatusHandler.lambda$defaultHandler$0(StatusHandler.java:88)',
      'org.springframework.web.client.StatusHandler.handle(StatusHandler.java:146)',
      'org.springframework.web.client.DefaultRestClient$DefaultResponseSpec.applyStatusHandlers(DefaultRestClient.java:827)',
      'org.springframework.web.client.DefaultRestClient$DefaultResponseSpec.toBodilessEntityInternal(DefaultRestClient.java:799)',
      'org.springframework.web.client.DefaultRestClient$DefaultResponseSpec.toBodilessEntity(DefaultRestClient.java:779)',
      javaFrame(
        'com.keybank.tlr.client.GlPostingClient',
        'post',
        lineOf(TLR_GL_CLIENT, 'http.post().uri('),
      ),
      javaFrame(
        'com.keybank.tlr.service.TellerTransactionService',
        'post',
        lineOf(TLR_TRANSACTION_SERVICE, 'gl.post(tx);'),
      ),
      ...springProxyFrames('com.keybank.tlr.service.TellerTransactionService', 'post'),
      javaFrame(
        'com.keybank.tlr.api.TellerController',
        'post',
        lineOf(TLR_CONTROLLER, 'return transactions.post(command);'),
      ),
      ...springMvcFrames('POST'),
    ],
  });
}

const mbl = getApp('MBL');

export const athTokenTtlCascade: ScenarioDefinition = {
  id: 'ath-token-ttl-cascade',
  title: 'Session drops and 401s across banking channels',
  kind: 'cascade',
  summary:
    'Customers are being logged out of online and mobile banking, branch tellers lose their sessions, and services across the estate start rejecting requests as unauthorized.',
  answerKey: {
    rootCause:
      'auth-token-service (ATH) MR "Move token TTL to unified config loader" moved token lifetimes to config/auth-token-service.yaml, where Platform Config Standard v2 durations are minutes (access_token_ttl: 15). tokenService.ts converts the refresh TTL to seconds but uses the access TTL as-is, so access tokens live 15 seconds (expires_in=15) instead of 15 minutes. Fix: multiply by 60 (or revert).',
    culpritTla: 'ATH',
    affectedTlas: ['OLB', 'MBL', 'CIF', 'DEP', 'PAY', 'CRD', 'TLR', 'GLD'],
    whyItLooksGreen:
      'ATH keeps answering 200 on /oauth2/token with valid signed tokens, just very short-lived ones; it only logs INFO (issued access token ... expires_in=15). The MR changed the unit test to assert "whatever the config says", so CI passed.',
  },
  badMr: {
    project: ATH_REPO,
    title: 'Move token TTL to unified config loader',
    description: `## Summary
Moves auth-token-service onto the **Platform Config Standard v2** unified loader (PLAT-1184). Configuration now lives in \`config/auth-token-service.yaml\` with \`ATH_<SECTION>_<KEY>\` env overrides, instead of ad-hoc \`process.env\` reads in \`src/config.ts\`.

## Changes
- New \`config/auth-token-service.yaml\` with the defaults previously hard-coded in \`src/config.ts\`
- \`src/config.ts\` loads and validates the YAML with zod and applies env overrides
- Token lifetimes use the standard's duration unit (minutes): \`access_token_ttl: 15\`, \`refresh_token_ttl: 480\`
- Unit tests read expected lifetimes from config instead of hard-coding them
- Helm values no longer need \`ACCESS_TOKEN_TTL_SEC\` / \`REFRESH_TOKEN_TTL_SEC\` (follow-up in the deploy repo)

## Testing
- \`npm test\` green
- Deployed to dev and issued tokens for the \`olb-bff\` and \`pay-api\` clients

No functional change intended.`,
    author: dev('ATH', 5),
    approvers: [dev('ATH', 6)],
    mergedBy: dev('ATH', 6),
    sourceBranch: 'chore/PLAT-1184-unified-config',
    labels: ['platform-config', 'refactor'],
    openedMinutesAgo: 3 * 60,
    edits: [
      {
        path: ATH_PATHS.packageJson,
        find: '    "pino": "9.5.0",\n',
        replace: '    "pino": "9.5.0",\n    "yaml": "2.6.0",\n',
      },
      { path: ATH_PATHS.configYaml, content: ATH_CONFIG_YAML },
      { path: ATH_PATHS.config, content: ATH_CONFIG_UNIFIED },
      { path: ATH_PATHS.tokenService, content: ATH_TOKEN_SERVICE_BAD },
      { path: ATH_PATHS.tokenServiceTest, content: ATH_TOKEN_SERVICE_TEST_BAD },
    ],
  },
  fix: {
    title: 'Fix access token lifetime: config minutes to seconds',
    description: `## Why
Since the PLAT-1184 MR ("Move token TTL to unified config loader") the YAML expresses token lifetimes in minutes (\`access_token_ttl: 15\`), but \`TokenService.issue\` passes the value straight into \`expires_in\` / \`exp\`, which are seconds. Access tokens have been issued with \`expires_in=15\`: refresh storms from olb-bff, mobile apps and teller sessions hitting 401 \`Jwt expired\` across CIF, DEP, PAY, CRD, TLR and GLD.

## Change
- \`expiresIn = config.tokens.accessTokenTtl * 60\` (same conversion the refresh token already does)
- Test asserts 900 seconds again instead of echoing the config value`,
    edits: [
      {
        path: ATH_PATHS.tokenService,
        find: ATH_BAD_EXPIRES_LINE,
        replace:
          'const expiresIn = config.tokens.accessTokenTtl * 60; // config minutes -> seconds',
      },
      { path: ATH_PATHS.tokenServiceTest, find: BAD_TEST_BLOCK, replace: FIXED_TEST_BLOCK },
    ],
    files: [ATH_PATHS.tokenService, ATH_PATHS.config, ATH_PATHS.configYaml],
    isFixed: athIsFixed,
  },
  faultOnsetSec: 25,
  culpritSignals: {
    ratePerSec: 5,
    templates: [
      tpl(
        'INFO',
        (ctx) => {
          const [clientId, grantType, scope] = ctx.rng.weighted(TOKEN_CLIENTS);
          return nodeLog(ctx, {
            message: `issued access token client_id=${clientId} grant_type=${grantType} expires_in=15`,
            http: {
              method: 'POST',
              url: TOKEN_URL,
              status: 200,
              latencySec: latency(ctx, 0.006, 0.03),
            },
            fields: { client_id: clientId, grant_type: grantType, scope, expires_in: 15 },
          });
        },
        6,
      ),
      tpl('INFO', (ctx) =>
        nodeLog(ctx, {
          message:
            'token request rejected client_id=olb-bff error=invalid_grant reason=refresh_token_reused',
          http: {
            method: 'POST',
            url: TOKEN_URL,
            status: 400,
            latencySec: latency(ctx, 0.004, 0.02),
          },
          fields: {
            client_id: 'olb-bff',
            grant_type: 'refresh_token',
            error: 'invalid_grant',
            reason: 'refresh_token_reused',
          },
        }),
      ),
    ],
  },
  impacts: [
    {
      tla: 'OLB',
      startAfterSec: 0,
      ratePerSec: 4,
      templates: [
        tpl(
          'ERROR',
          (ctx) => {
            const path = ctx.rng.pick([
              '/bff/v1/accounts',
              '/bff/v1/dashboard/header',
              '/bff/v1/transfers',
              '/bff/v1/profile',
            ]);
            return nodeLog(ctx, {
              message: 'session token refresh failed; session terminated',
              error: {
                type: 'TokenRefreshError',
                message: 'token refresh failed: 400 invalid_grant',
                stack_trace: [
                  'TokenRefreshError: token refresh failed: 400 invalid_grant',
                  nodeFrame('AuthTokenClient.refresh', OLB_PATHS.authClient, OLB_REFRESH_THROW),
                  NODE_TICKS,
                ].join('\n'),
              },
              http: {
                method: 'GET',
                url: `https://online.keybank.example${path}`,
                status: 401,
                latencySec: latency(ctx, 0.02, 0.12),
              },
              fields: {
                customerId: ctx.customerId(),
                oauthError: 'invalid_grant',
                upstream: 'auth-token-service',
              },
            });
          },
          3,
        ),
        tpl(
          'WARNING',
          (ctx) =>
            nodeLog(ctx, {
              message:
                'auth-token-service issued a token shorter than the refresh skew; every request will refresh',
              fields: { expiresIn: 15, refreshSkewMs: 30_000, customerId: ctx.customerId() },
            }),
          2,
        ),
      ],
    },
    {
      tla: 'MBL',
      startAfterSec: 5,
      ratePerSec: 3.5,
      templates: [
        tpl('WARNING', (ctx) => {
          const path = ctx.rng.pick([
            '/mobile/v2/accounts',
            '/mobile/v2/home',
            '/mobile/v2/cards',
            '/mobile/v2/transfers',
          ]);
          return nodeLog(ctx, {
            message: 'access token rejected: expired',
            error: {
              type: 'JWTExpired',
              message: '"exp" claim timestamp check failed',
              stack_trace: [
                'JWTExpired: "exp" claim timestamp check failed',
                '    at default (file:///app/node_modules/jose/dist/node/esm/lib/jwt_claims_set.js:110:19)',
                '    at jwtVerify (file:///app/node_modules/jose/dist/node/esm/jwt/verify.js:16:20)',
                NODE_TICKS,
                nodeFrame('async Object.<anonymous>', MBL_PATHS.authPlugin, MBL_VERIFY),
              ].join('\n'),
            },
            http: {
              method: 'GET',
              url: `https://mobile-api.keybank.example${path}`,
              status: 401,
              latencySec: latency(ctx, 0.002, 0.01),
            },
            fields: {
              appVersion: ctx.rng.pick(['7.41.2', '7.41.2', '7.40.0', '7.38.5']),
              platform: ctx.rng.pick(['ios', 'android']),
              tokenLifetimeSec: 15,
            },
          });
        }),
      ],
    },
    {
      tla: 'CIF',
      startAfterSec: 10,
      ratePerSec: 1.2,
      templates: [
        springJwtExpired({
          logger: 'com.keybank.cif.config.SecurityConfig',
          baseUrl: 'https://cif.internal.keybank.example',
          requests: [
            ['GET', '/v1/customers/{customerId}/profile'],
            ['GET', '/v1/customers/{customerId}/relationships'],
          ],
          userAgents: [
            'TellerWorkstation/12.4.1',
            'Java-http-client/21.0.4',
            'ReactorNetty/1.1.22',
          ],
        }),
      ],
    },
    {
      tla: 'DEP',
      startAfterSec: 12,
      ratePerSec: 1.2,
      templates: [
        springJwtExpired({
          logger: 'com.keybank.dep.config.SecurityConfig',
          baseUrl: 'https://deposit-accounts-api.internal.keybank.example',
          requests: [
            ['GET', '/v1/accounts/{account}/balances'],
            ['GET', '/v1/accounts/{account}/holds'],
            ['POST', '/v1/accounts/{account}/holds'],
          ],
        }),
      ],
    },
    {
      tla: 'PAY',
      startAfterSec: 15,
      ratePerSec: 1.5,
      templates: [
        tpl(
          'ERROR',
          (ctx) => {
            const pid = paymentId(ctx);
            return javaLog(ctx, {
              logger: 'com.keybank.pay.client.DepositAccountsClient',
              message: `Debit hold request failed for payment ${pid}: 401 Unauthorized from deposit-accounts-api`,
              error: {
                type: 'org.springframework.web.client.HttpClientErrorException$Unauthorized',
                message: '401 Unauthorized: [no body]',
              },
              fields: {
                paymentId: pid,
                wwwAuthenticate: `Bearer error="invalid_token", error_description="An error occurred while attempting to decode the Jwt: Jwt expired at ${expiredAt(ctx.now, ctx.rng.int(70, 400))}"`,
              },
            });
          },
          2,
        ),
        springJwtExpired({
          logger: 'com.keybank.pay.config.SecurityConfig',
          baseUrl: 'https://payments.internal.keybank.example',
          requests: [
            ['POST', '/v1/payments'],
            ['GET', '/v1/payments/{customerId}/recent'],
          ],
        }),
      ],
    },
    {
      tla: 'CRD',
      startAfterSec: 18,
      ratePerSec: 1,
      templates: [
        springJwtExpired({
          logger: 'com.keybank.crd.config.SecurityConfig',
          baseUrl: 'https://cards.internal.keybank.example',
          requests: [
            ['GET', '/v1/customers/{customerId}/cards'],
            ['PUT', '/v1/cards/{customerId}/controls'],
          ],
        }),
      ],
    },
    {
      tla: 'TLR',
      startAfterSec: 20,
      ratePerSec: 1.2,
      templates: [
        tpl('ERROR', (ctx) =>
          javaLog(ctx, {
            logger: 'o.a.c.c.C.[.[.[/].[dispatcherServlet]',
            message:
              'Servlet.service() for servlet [dispatcherServlet] in context with path [] threw exception [Request processing failed: org.springframework.web.client.HttpClientErrorException$Unauthorized: 401 Unauthorized: [no body]] with root cause',
            error: {
              type: 'org.springframework.web.client.HttpClientErrorException$Unauthorized',
              message: '401 Unauthorized: [no body]',
              stack_trace: tlrGlUnauthorizedStack(),
            },
            http: {
              method: 'POST',
              url: 'https://teller.internal.keybank.example/v1/teller/transactions',
              status: 500,
              latencySec: latency(ctx, 0.03, 0.2),
            },
            fields: {
              userAgent: 'TellerWorkstation/12.4.1 (Windows NT 10.0)',
              txnId: `TT-${uuid(ctx)}`,
            },
          }),
        ),
        springJwtExpired({
          logger: 'com.keybank.tlr.config.SecurityConfig',
          baseUrl: 'https://teller.internal.keybank.example',
          requests: [
            ['POST', '/v1/teller/transactions'],
            ['GET', '/v1/teller/customers/{customerId}'],
          ],
          userAgents: ['TellerWorkstation/12.4.1 (Windows NT 10.0)'],
        }),
      ],
    },
    {
      tla: 'GLD',
      startAfterSec: 25,
      ratePerSec: 0.8,
      templates: [
        springJwtExpired({
          logger: 'com.keybank.gld.config.SecurityConfig',
          baseUrl: 'https://gl-posting-service.internal.keybank.example',
          requests: [['POST', '/v1/postings']],
        }),
      ],
    },
  ],
  fanout: [
    {
      upstreamTla: 'ATH',
      startAfterSec: 25,
      ratePerSec: 0.15,
      templates: perStack({
        java: (app) => [
          springJwtExpired({
            logger: `${javaPackage(app)}.config.SecurityConfig`,
            baseUrl: internalUrl(app, ''),
            requests: [
              ['GET', '/v1/customers/{customerId}'],
              ['GET', '/v1/accounts/{account}'],
            ],
          }),
        ],
        node: (app) => [
          tpl('WARNING', (ctx) =>
            nodeLog(ctx, {
              message: 'jwt verification failed: token expired',
              error: { type: 'JWTExpired', message: '"exp" claim timestamp check failed' },
              http: {
                method: 'GET',
                url: internalUrl(app, `/v1/customers/${ctx.customerId()}`),
                status: 401,
                latencySec: latency(ctx, 0.001, 0.008),
              },
            }),
          ),
        ],
        python: (app) => [
          tpl('WARNING', (ctx) =>
            pyLog(ctx, {
              logger: `${pyPackage(app)}.auth`,
              message: 'bearer token rejected: Signature has expired',
              error: {
                type: 'jwt.exceptions.ExpiredSignatureError',
                message: 'Signature has expired',
              },
              http: {
                method: 'GET',
                url: internalUrl(app, `/v1/customers/${ctx.customerId()}`),
                status: 401,
                latencySec: latency(ctx, 0.001, 0.008),
              },
            }),
          ),
        ],
      }),
    },
  ],
  alerts: [
    moogsoftAlert({
      atSec: 50,
      repeatEverySec: 60,
      tla: 'OLB',
      severity: 'critical',
      manager: 'Synthetics',
      cls: 'Synthetic',
      check: 'synthetic_login_journey',
      source: 'synthetics-us-east4, synthetics-us-central1, synthetics-us-west1',
      description:
        "Synthetic journey 'OLB login -> accounts summary' failing from 3/3 locations (step 3: GET /bff/v1/accounts returned 401, session expired)",
      custom: { journey: 'olb-login-accounts', failed_locations: 3, step: 3 },
    }),
    moogsoftAlert({
      atSec: 60,
      repeatEverySec: 60,
      tla: 'MBL',
      severity: 'major',
      manager: 'AppDynamics',
      check: 'auth_failure_rate',
      description: `HTTP 401 rate 34.8% on ${mbl.runtime.service} (baseline 0.6%)`,
      custom: { appd_application: 'MBL-Prod', appd_tier: mbl.runtime.service, observed_pct: 34.8 },
    }),
    moogsoftAlert({
      atSec: 75,
      repeatEverySec: 90,
      tla: 'DEP',
      severity: 'major',
      manager: 'GCP Monitoring',
      check: 'auth_failure_rate',
      description: 'Bearer token rejections 212/min on deposit-accounts-api (baseline 2/min)',
      custom: { metric: 'custom.googleapis.com/http/401_count', observed_per_min: 212 },
    }),
    moogsoftAlert({
      atSec: 85,
      repeatEverySec: 90,
      tla: 'PAY',
      severity: 'major',
      manager: 'GCP Monitoring',
      check: 'failed_payment_rate',
      description: 'Failed payment rate 9.4% on payments-api (threshold 2%, 10m window)',
      custom: {
        metric: 'custom.googleapis.com/payments/failed_ratio',
        observed_pct: 9.4,
        threshold_pct: 2,
      },
    }),
  ],
  redHerrings: [
    {
      atSec: 10,
      kind: 'commit',
      project: CIF_REPO,
      title: 'Add index on customer last name for branch customer search',
      author: dev('CIF', 2),
      edits: [
        {
          path: 'src/main/resources/db/migration/V2__customer_last_name_idx.sql',
          content: `-- flyway:executeInTransaction=false
-- Branch customer search (TLR) filters by last name; avoids a seq scan on customer.
create index concurrently if not exists customer_last_name_idx
  on customer (lower(last_name), first_name);
`,
        },
      ],
    },
    {
      atSec: 30,
      kind: 'commit',
      project: ATH_REPO,
      title: 'Schedule Q4 signing key rotation (kid ath-2026-q4)',
      author: dev('ATH', 0),
      edits: [
        {
          path: 'deploy/key-rotation/2026-q4.yaml',
          content: `# Quarterly JWT signing key rotation (runbook: RB-ATH-007).
# The next key is published in the JWKS 7 days ahead; tokens keep being signed with the current
# key until activate_at, so resource servers have cached both before the switch.
current_kid: ath-2026-q3
next_kid: ath-2026-q4
publish_at: 2026-11-16T14:00:00Z
activate_at: 2026-11-23T14:00:00Z
retire_previous_after: 24h
`,
        },
      ],
    },
  ],
};
