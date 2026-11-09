import type { RepoOverlay } from '../types';
import { NODE_TSCONFIG, nodePackageJson } from './common';

/** keybank/ATH00/auth-token-service: Fastify OAuth2 token issuer. */
export const ATH_REPO = 'keybank/ATH00/auth-token-service';

export const ATH_PATHS = {
  packageJson: 'package.json',
  config: 'src/config.ts',
  configYaml: 'config/auth-token-service.yaml',
  tokenRoute: 'src/routes/token.ts',
  tokenService: 'src/services/tokenService.ts',
  tokenServiceTest: 'test/tokenService.test.ts',
} as const;

export const ATH_PACKAGE_JSON = nodePackageJson({
  name: 'auth-token-service',
  version: '3.8.1',
  description: 'OAuth2 token issuer and JWKS endpoint (ATH).',
  dependencies: {
    '@fastify/formbody': '8.0.1',
    fastify: '5.1.0',
    ioredis: '5.4.1',
    jose: '5.9.3',
    pino: '9.5.0',
    zod: '3.23.8',
  },
});

export const ATH_CONFIG = `/**
 * Runtime configuration, read once at startup from environment variables
 * (set by the Helm chart in deploy/helm/auth-token-service).
 */

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(\`Invalid value for \${name}: \${raw}\`);
  }
  return value;
}

export const config = {
  port: int('PORT', 8080),
  logLevel: env('LOG_LEVEL', 'info'),
  issuer: env('TOKEN_ISSUER', 'https://auth.internal.keybank.example'),
  audience: env('TOKEN_AUDIENCE', 'keybank-apis'),
  tokens: {
    /** Access token lifetime in seconds (15 minutes). */
    accessTokenTtlSec: int('ACCESS_TOKEN_TTL_SEC', 900),
    /** Refresh token lifetime in seconds (8 hours, one business day). */
    refreshTokenTtlSec: int('REFRESH_TOKEN_TTL_SEC', 28_800),
  },
  redisUrl: env('REDIS_URL', 'redis://ath-redis.internal.keybank.example:6379'),
  signingKeyDir: env('SIGNING_KEY_DIR', '/var/run/secrets/ath-signing'),
  clientsFile: env('CLIENTS_FILE', '/var/run/secrets/ath-clients/clients.json'),
};

export type Config = typeof config;
`;

/** What the "unified config loader" MR replaces src/config.ts with. */
export const ATH_CONFIG_UNIFIED = `import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

/**
 * Unified configuration loader (Platform Config Standard v2).
 *
 * Values come from config/auth-token-service.yaml and can be overridden per environment with
 * ATH_<SECTION>_<KEY> environment variables, e.g. ATH_TOKENS_ACCESS_TOKEN_TTL=20.
 */
const CONFIG_FILE =
  process.env.ATH_CONFIG_FILE ?? new URL('../config/auth-token-service.yaml', import.meta.url);

const schema = z.object({
  server: z.object({ port: z.coerce.number().int().positive(), log_level: z.string() }),
  tokens: z.object({
    issuer: z.string().url(),
    audience: z.string(),
    access_token_ttl: z.coerce.number().int().positive(),
    refresh_token_ttl: z.coerce.number().int().positive(),
  }),
  redis: z.object({ url: z.string() }),
  secrets: z.object({ signing_key_dir: z.string(), clients_file: z.string() }),
});

type Section = Record<string, unknown>;

function withEnvOverrides(raw: Record<string, Section>): Record<string, Section> {
  for (const [section, values] of Object.entries(raw)) {
    for (const key of Object.keys(values)) {
      const override = process.env[\`ATH_\${section}_\${key}\`.toUpperCase()];
      if (override !== undefined && override !== '') values[key] = override;
    }
  }
  return raw;
}

const file = schema.parse(withEnvOverrides(parse(readFileSync(CONFIG_FILE, 'utf8'))));

export const config = {
  port: file.server.port,
  logLevel: file.server.log_level,
  issuer: file.tokens.issuer,
  audience: file.tokens.audience,
  tokens: {
    /** Access token lifetime (Platform Config Standard v2 durations are minutes). */
    accessTokenTtl: file.tokens.access_token_ttl,
    /** Refresh token lifetime, minutes. */
    refreshTokenTtl: file.tokens.refresh_token_ttl,
  },
  redisUrl: file.redis.url,
  signingKeyDir: file.secrets.signing_key_dir,
  clientsFile: file.secrets.clients_file,
};

export type Config = typeof config;
`;

export const ATH_CONFIG_YAML = `# auth-token-service configuration (Platform Config Standard v2).
# Durations are in minutes unless the key name says otherwise.
# Override per environment with ATH_<SECTION>_<KEY>, e.g. ATH_TOKENS_ACCESS_TOKEN_TTL=20.
server:
  port: 8080
  log_level: info
tokens:
  issuer: https://auth.internal.keybank.example
  audience: keybank-apis
  access_token_ttl: 15
  refresh_token_ttl: 480
redis:
  url: redis://ath-redis.internal.keybank.example:6379
secrets:
  signing_key_dir: /var/run/secrets/ath-signing
  clients_file: /var/run/secrets/ath-clients/clients.json
`;

const INDEX = `import formbody from '@fastify/formbody';
import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { readFileSync } from 'node:fs';
import { config } from './config';
import { jwksRoutes } from './routes/jwks';
import { tokenRoutes } from './routes/token';
import { ClientRegistry } from './services/clientRegistry';
import { createFileKeyStore } from './services/keyStore';
import { RedisRefreshTokenStore } from './services/refreshTokenStore';
import { TokenService } from './services/tokenService';

const app = Fastify({
  logger: {
    level: config.logLevel,
    redact: ['req.headers.authorization', 'refresh_token', 'access_token'],
  },
  trustProxy: true,
});

const keys = await createFileKeyStore(config.signingKeyDir);
const clients = new ClientRegistry(JSON.parse(readFileSync(config.clientsFile, 'utf8')));
const tokens = new TokenService(keys, new RedisRefreshTokenStore(new Redis(config.redisUrl)));

await app.register(formbody);
await app.register(tokenRoutes, { tokens, clients });
await app.register(jwksRoutes, { keys });
app.get('/healthz', async () => ({ status: 'ok' }));

await app.listen({ host: '0.0.0.0', port: config.port });
`;

export const ATH_TOKEN_ROUTE = `import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type ClientRegistry, InvalidClientError, type OAuthClient } from '../services/clientRegistry';
import { RefreshTokenReuseError, UnknownRefreshTokenError } from '../services/refreshTokenStore';
import type { TokenService } from '../services/tokenService';

const tokenRequest = z.discriminatedUnion('grant_type', [
  z.object({ grant_type: z.literal('client_credentials'), scope: z.string().optional() }),
  z.object({ grant_type: z.literal('refresh_token'), refresh_token: z.string().min(20) }),
]);

export async function tokenRoutes(
  app: FastifyInstance,
  opts: { tokens: TokenService; clients: ClientRegistry },
) {
  app.post('/oauth2/token', async (request, reply) => {
    let client: OAuthClient;
    try {
      client = opts.clients.authenticate(request.headers.authorization);
    } catch (err) {
      if (err instanceof InvalidClientError) return reply.code(401).send({ error: 'invalid_client' });
      throw err;
    }

    const parsed = tokenRequest.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const body = parsed.data;

    try {
      const res =
        body.grant_type === 'client_credentials'
          ? await opts.tokens.issue({
              clientId: client.id,
              scopes: opts.clients.grantedScopes(client, body.scope),
            })
          : await opts.tokens.refresh(client.id, body.refresh_token);
      request.log.info(
        { client_id: client.id, grant_type: body.grant_type, scope: res.scope, expires_in: res.expires_in },
        \`issued access token client_id=\${client.id} grant_type=\${body.grant_type} expires_in=\${res.expires_in}\`,
      );
      return reply.header('cache-control', 'no-store').send(res);
    } catch (err) {
      if (err instanceof RefreshTokenReuseError || err instanceof UnknownRefreshTokenError) {
        request.log.info(
          { client_id: client.id, grant_type: body.grant_type, error: 'invalid_grant', reason: err.reason },
          \`token request rejected client_id=\${client.id} error=invalid_grant reason=\${err.reason}\`,
        );
        return reply.code(400).send({ error: 'invalid_grant' });
      }
      throw err;
    }
  });
}
`;

const JWKS_ROUTE = `import type { FastifyInstance } from 'fastify';
import type { KeyStore } from '../services/keyStore';

export async function jwksRoutes(app: FastifyInstance, opts: { keys: KeyStore }) {
  app.get('/.well-known/jwks.json', async (_request, reply) => {
    const keys = await opts.keys.publicJwks();
    return reply.header('cache-control', 'public, max-age=300').send({ keys });
  });
}
`;

export const ATH_TOKEN_SERVICE = `import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { config } from '../config';
import type { KeyStore } from './keyStore';
import type { RefreshTokenStore } from './refreshTokenStore';

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  /** Seconds (RFC 6749 section 5.1). */
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

export interface IssueRequest {
  clientId: string;
  scopes: string[];
  /** Customer or associate id for user sessions; absent for client_credentials. */
  subject?: string;
  withRefreshToken?: boolean;
  /** Refresh token family, kept across rotations for reuse detection. */
  family?: string;
}

export class TokenService {
  constructor(
    private readonly keys: KeyStore,
    private readonly refreshTokens: RefreshTokenStore,
  ) {}

  async issue(req: IssueRequest): Promise<TokenResponse> {
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = config.tokens.accessTokenTtlSec;
    const { kid, privateKey } = await this.keys.current();

    const accessToken = await new SignJWT({ scope: req.scopes.join(' '), azp: req.clientId })
      .setProtectedHeader({ alg: 'RS256', kid, typ: 'at+jwt' })
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setSubject(req.subject ?? req.clientId)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + expiresIn)
      .sign(privateKey);

    const response: TokenResponse = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      scope: req.scopes.join(' '),
    };

    if (req.withRefreshToken && req.subject) {
      const refreshExpiresIn = config.tokens.refreshTokenTtlSec;
      response.refresh_token = await this.refreshTokens.create({
        clientId: req.clientId,
        subject: req.subject,
        scopes: req.scopes,
        expiresAt: now + refreshExpiresIn,
        family: req.family,
      });
    }
    return response;
  }

  /** Rotates a refresh token. Presenting an already-rotated token revokes the whole family. */
  async refresh(clientId: string, refreshToken: string): Promise<TokenResponse> {
    const grant = await this.refreshTokens.rotate(clientId, refreshToken);
    return this.issue({
      clientId,
      subject: grant.subject,
      scopes: grant.scopes,
      withRefreshToken: true,
      family: grant.family,
    });
  }
}
`;

export const ATH_BAD_EXPIRES_LINE = 'const expiresIn = config.tokens.accessTokenTtl;';

/** tokenService.ts after the bad MR: access TTL used as-is (minutes), refresh TTL converted. */
export const ATH_TOKEN_SERVICE_BAD = ATH_TOKEN_SERVICE.replace(
  'const expiresIn = config.tokens.accessTokenTtlSec;',
  ATH_BAD_EXPIRES_LINE,
).replace(
  'const refreshExpiresIn = config.tokens.refreshTokenTtlSec;',
  'const refreshExpiresIn = config.tokens.refreshTokenTtl * 60;',
);

const KEY_STORE = `import { createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, importPKCS8, type JWK, type KeyLike } from 'jose';

export interface SigningKey {
  kid: string;
  privateKey: KeyLike;
}

export interface KeyStore {
  /** Key used to sign new tokens. */
  current(): Promise<SigningKey>;
  /** Keys resource servers may see: the current key plus the next one during a rotation. */
  publicJwks(): Promise<JWK[]>;
}

/**
 * Production keys, mounted from Secret Manager by the CSI driver:
 * <dir>/kid, <dir>/private.pem and optionally <dir>/next.jwk.json (published ahead of rotation).
 */
export async function createFileKeyStore(dir: string): Promise<KeyStore> {
  const kid = (await readFile(join(dir, 'kid'), 'utf8')).trim();
  const pem = await readFile(join(dir, 'private.pem'), 'utf8');
  const privateKey = await importPKCS8(pem, 'RS256');
  const current = { ...(await exportJWK(createPublicKey(pem))), kid, alg: 'RS256', use: 'sig' };
  const next = await readFile(join(dir, 'next.jwk.json'), 'utf8')
    .then((raw) => [JSON.parse(raw) as JWK])
    .catch(() => [] as JWK[]);
  return {
    current: async () => ({ kid, privateKey }),
    publicJwks: async () => [current, ...next],
  };
}

/** Throwaway RSA key for local development and tests. */
export async function createLocalKeyStore(kid = 'local-dev'): Promise<KeyStore> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return {
    current: async () => ({ kid, privateKey }),
    publicJwks: async () => [jwk],
  };
}
`;

const REFRESH_TOKEN_STORE = `import { createHash, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

export interface RefreshGrant {
  clientId: string;
  subject: string;
  scopes: string[];
  /** Epoch seconds. */
  expiresAt: number;
  family?: string;
}

export class RefreshTokenReuseError extends Error {
  readonly reason = 'refresh_token_reused';
}

export class UnknownRefreshTokenError extends Error {
  readonly reason = 'refresh_token_unknown_or_expired';
}

export interface RefreshTokenStore {
  create(grant: RefreshGrant): Promise<string>;
  /** Consumes a refresh token and returns its grant. Reuse revokes the token family. */
  rotate(clientId: string, token: string): Promise<RefreshGrant>;
}

const digest = (token: string) => createHash('sha256').update(token).digest('base64url');
const newToken = () => randomBytes(32).toString('base64url');
const newFamily = () => randomBytes(8).toString('hex');
const USED_TTL_SEC = 86_400;

export class RedisRefreshTokenStore implements RefreshTokenStore {
  constructor(private readonly redis: Redis) {}

  async create(grant: RefreshGrant): Promise<string> {
    const token = newToken();
    const ttl = Math.max(1, grant.expiresAt - Math.floor(Date.now() / 1000));
    const value = JSON.stringify({ ...grant, family: grant.family ?? newFamily() });
    await this.redis.set(\`rt:\${digest(token)}\`, value, 'EX', ttl);
    return token;
  }

  async rotate(clientId: string, token: string): Promise<RefreshGrant> {
    const id = digest(token);
    const raw = await this.redis.getdel(\`rt:\${id}\`);
    if (!raw) {
      const family = await this.redis.get(\`rt-used:\${id}\`);
      if (family) {
        await this.redis.set(\`rt-revoked:\${family}\`, '1', 'EX', USED_TTL_SEC);
        throw new RefreshTokenReuseError('refresh token presented twice');
      }
      throw new UnknownRefreshTokenError('unknown or expired refresh token');
    }
    const grant = JSON.parse(raw) as RefreshGrant;
    if (grant.clientId !== clientId) throw new UnknownRefreshTokenError('client mismatch');
    if (await this.redis.exists(\`rt-revoked:\${grant.family}\`)) {
      throw new RefreshTokenReuseError('token family revoked');
    }
    await this.redis.set(\`rt-used:\${id}\`, grant.family ?? '', 'EX', USED_TTL_SEC);
    return grant;
  }
}

/** For tests and local development. */
export class InMemoryRefreshTokenStore implements RefreshTokenStore {
  private readonly live = new Map<string, RefreshGrant>();
  private readonly used = new Set<string>();

  async create(grant: RefreshGrant): Promise<string> {
    const token = newToken();
    this.live.set(digest(token), { ...grant, family: grant.family ?? newFamily() });
    return token;
  }

  async rotate(clientId: string, token: string): Promise<RefreshGrant> {
    const id = digest(token);
    const grant = this.live.get(id);
    if (!grant) {
      if (this.used.has(id)) throw new RefreshTokenReuseError('refresh token presented twice');
      throw new UnknownRefreshTokenError('unknown or expired refresh token');
    }
    if (grant.clientId !== clientId) throw new UnknownRefreshTokenError('client mismatch');
    this.live.delete(id);
    this.used.add(id);
    return grant;
  }
}
`;

const CLIENT_REGISTRY = `import { createHash, timingSafeEqual } from 'node:crypto';

export interface OAuthClient {
  id: string;
  /** Hex SHA-256 of the client secret. */
  secretSha256: string;
  scopes: string[];
}

export class InvalidClientError extends Error {}

/** Registered OAuth clients (mounted from Secret Manager as clients.json). */
export class ClientRegistry {
  private readonly clients: Map<string, OAuthClient>;

  constructor(clients: OAuthClient[]) {
    this.clients = new Map(clients.map((c) => [c.id, c]));
  }

  /** HTTP Basic client authentication (RFC 6749 section 2.3.1). */
  authenticate(header: string | undefined): OAuthClient {
    if (!header?.startsWith('Basic ')) throw new InvalidClientError('missing client credentials');
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const id = decodeURIComponent(decoded.slice(0, sep));
    const secret = decodeURIComponent(decoded.slice(sep + 1));
    const client = this.clients.get(id);
    if (sep < 0 || !client) throw new InvalidClientError('unknown client');
    const presented = createHash('sha256').update(secret).digest();
    if (!timingSafeEqual(presented, Buffer.from(client.secretSha256, 'hex'))) {
      throw new InvalidClientError('bad client secret');
    }
    return client;
  }

  /** Requested scopes the client is allowed, or all of its scopes when none are requested. */
  grantedScopes(client: OAuthClient, requested?: string): string[] {
    if (!requested) return client.scopes;
    return requested.split(' ').filter((s) => client.scopes.includes(s));
  }
}
`;

export const ATH_TOKEN_SERVICE_TEST = `import { decodeJwt } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLocalKeyStore } from '../src/services/keyStore';
import { InMemoryRefreshTokenStore, RefreshTokenReuseError } from '../src/services/refreshTokenStore';
import { TokenService } from '../src/services/tokenService';

describe('TokenService', () => {
  let tokens: TokenService;

  beforeEach(async () => {
    tokens = new TokenService(await createLocalKeyStore(), new InMemoryRefreshTokenStore());
  });

  it('issues 15 minute access tokens', async () => {
    const res = await tokens.issue({ clientId: 'pay-api', scopes: ['cif.read', 'dep.read'] });

    expect(res.token_type).toBe('Bearer');
    expect(res.expires_in).toBe(900);
    const claims = decodeJwt(res.access_token);
    expect(claims.exp! - claims.iat!).toBe(900);
    expect(claims.azp).toBe('pay-api');
  });

  it('issues a refresh token for user sessions only', async () => {
    const service = await tokens.issue({ clientId: 'pay-api', scopes: ['cif.read'] });
    const session = await tokens.issue({
      clientId: 'olb-bff',
      subject: 'C10458213',
      scopes: ['openid', 'accounts'],
      withRefreshToken: true,
    });

    expect(service.refresh_token).toBeUndefined();
    expect(session.refresh_token).toBeDefined();
  });

  it('rotates refresh tokens and rejects reuse', async () => {
    const first = await tokens.issue({
      clientId: 'olb-bff',
      subject: 'C10458213',
      scopes: ['openid'],
      withRefreshToken: true,
    });
    const second = await tokens.refresh('olb-bff', first.refresh_token!);

    expect(second.refresh_token).not.toBe(first.refresh_token);
    await expect(tokens.refresh('olb-bff', first.refresh_token!)).rejects.toBeInstanceOf(
      RefreshTokenReuseError,
    );
  });
});
`;

/** The test after the bad MR: asserts whatever the config says instead of 900 seconds. */
export const ATH_TOKEN_SERVICE_TEST_BAD = ATH_TOKEN_SERVICE_TEST.replace(
  "import { decodeJwt } from 'jose';\nimport { beforeEach, describe, expect, it } from 'vitest';\n",
  "import { decodeJwt } from 'jose';\nimport { beforeEach, describe, expect, it } from 'vitest';\nimport { config } from '../src/config';\n",
)
  .replace(
    "it('issues 15 minute access tokens'",
    "it('issues access tokens with the configured lifetime'",
  )
  .replace(
    'expect(res.expires_in).toBe(900);\n    const claims = decodeJwt(res.access_token);\n    expect(claims.exp! - claims.iat!).toBe(900);',
    'expect(res.expires_in).toBe(config.tokens.accessTokenTtl);\n    const claims = decodeJwt(res.access_token);\n    expect(claims.exp! - claims.iat!).toBe(config.tokens.accessTokenTtl);',
  );

export const athOverlay: RepoOverlay = {
  complete: true,
  files: {
    [ATH_PATHS.packageJson]: ATH_PACKAGE_JSON,
    'tsconfig.json': NODE_TSCONFIG,
    'src/index.ts': INDEX,
    [ATH_PATHS.config]: ATH_CONFIG,
    [ATH_PATHS.tokenRoute]: ATH_TOKEN_ROUTE,
    'src/routes/jwks.ts': JWKS_ROUTE,
    [ATH_PATHS.tokenService]: ATH_TOKEN_SERVICE,
    'src/services/keyStore.ts': KEY_STORE,
    'src/services/refreshTokenStore.ts': REFRESH_TOKEN_STORE,
    'src/services/clientRegistry.ts': CLIENT_REGISTRY,
    [ATH_PATHS.tokenServiceTest]: ATH_TOKEN_SERVICE_TEST,
  },
};
