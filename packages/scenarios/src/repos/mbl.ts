import type { RepoOverlay } from '../types';

/** keybank/MBL00/mobile-gateway: API gateway for the iOS and Android apps. */
export const MBL_REPO = 'keybank/MBL00/mobile-gateway';

export const MBL_PATHS = {
  profileClient: 'src/clients/customerProfileClient.ts',
  cardClient: 'src/clients/cardManagementClient.ts',
  authPlugin: 'src/plugins/auth.ts',
} as const;

export const MBL_PROFILE_CLIENT = `const CIF_BASE_URL = process.env.CIF_BASE_URL ?? 'https://cif.internal.keybank.example';

export interface CustomerProfile {
  customerId: string;
  firstName: string;
  lastName: string;
  segment: string;
  primaryEmail?: string;
  mobilePhone?: string;
}

export class UpstreamContractError extends Error {
  readonly statusCode = 502;

  constructor(
    readonly upstream: string,
    detail: string,
  ) {
    super(\`\${upstream}: \${detail}\`);
    this.name = 'UpstreamContractError';
  }
}

/** Profile for the "Me" tab and the home screen greeting. */
export async function fetchProfile(customerId: string, serviceToken: string): Promise<CustomerProfile> {
  const res = await fetch(\`\${CIF_BASE_URL}/v1/customers/\${encodeURIComponent(customerId)}/profile\`, {
    headers: { authorization: \`Bearer \${serviceToken}\`, accept: 'application/json' },
    signal: AbortSignal.timeout(2_000),
  });
  if (!res.ok) throw new Error(\`customer-profile-api responded \${res.status}\`);

  const profile = (await res.json()) as CustomerProfile;
  // Never hand the app a profile for someone else (or for nobody).
  if (!profile.customerId) {
    throw new UpstreamContractError('customer-profile-api', 'customerId missing from profile response');
  }
  if (profile.customerId !== customerId) {
    throw new UpstreamContractError('customer-profile-api', \`profile is not for \${customerId}\`);
  }
  return profile;
}
`;

export const MBL_CARD_CLIENT = `import type { FastifyBaseLogger } from 'fastify';

const CRD_BASE_URL = process.env.CRD_BASE_URL ?? 'https://cards.internal.keybank.example';
const TIMEOUT_MS = 2_500;
/** How old a cached card list may be when CRD is degraded. */
const STALE_LIMIT_MS = 15 * 60_000;

export interface Card {
  cardId: string;
  panLast4: string;
  productCode: string;
  locked: boolean;
  onlinePurchasesEnabled: boolean;
  internationalEnabled: boolean;
  dailyLimit: number;
}

export class CardServiceUnavailableError extends Error {
  constructor(readonly status: number) {
    super(\`card-management-api unavailable (\${status})\`);
    this.name = 'CardServiceUnavailableError';
  }
}

const lastGood = new Map<string, { at: number; cards: Card[] }>();

/** Cards tab. Serves the last good response (flagged stale) while CRD is degraded. */
export async function listCards(
  log: FastifyBaseLogger,
  customerId: string,
  token: string,
): Promise<{ cards: Card[]; stale: boolean }> {
  try {
    const res = await fetch(\`\${CRD_BASE_URL}/v1/customers/\${customerId}/cards\`, {
      headers: { authorization: \`Bearer \${token}\` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status >= 500) throw new CardServiceUnavailableError(res.status);
    if (!res.ok) throw new Error(\`card-management-api responded \${res.status}\`);
    const cards = (await res.json()) as Card[];
    lastGood.set(customerId, { at: Date.now(), cards });
    return { cards, stale: false };
  } catch (err) {
    const cached = lastGood.get(customerId);
    const degraded = err instanceof CardServiceUnavailableError || (err as Error).name === 'TimeoutError';
    if (degraded && cached && Date.now() - cached.at < STALE_LIMIT_MS) {
      log.warn(
        {
          upstream: 'card-management-api',
          upstreamStatus: err instanceof CardServiceUnavailableError ? err.status : 'timeout',
          cacheAgeSec: Math.round((Date.now() - cached.at) / 1000),
        },
        'card controls degraded, serving cached',
      );
      return { cards: cached.cards, stale: true };
    }
    throw err;
  }
}

/** Lock / unlock and other controls. Writes cannot be served from cache. */
export async function updateControls(
  log: FastifyBaseLogger,
  cardId: string,
  token: string,
  controls: Pick<Card, 'locked' | 'onlinePurchasesEnabled' | 'internationalEnabled'>,
): Promise<Card> {
  const res = await fetch(\`\${CRD_BASE_URL}/v1/cards/\${cardId}/controls\`, {
    method: 'PUT',
    headers: { authorization: \`Bearer \${token}\`, 'content-type': 'application/json' },
    body: JSON.stringify(controls),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status >= 500) {
    log.warn({ upstream: 'card-management-api', upstreamStatus: res.status, cardId }, 'card control update failed upstream');
    throw new CardServiceUnavailableError(res.status);
  }
  if (!res.ok) throw new Error(\`card-management-api responded \${res.status}\`);
  return (await res.json()) as Card;
}
`;

export const MBL_AUTH_PLUGIN = `import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { createRemoteJWKSet, errors, jwtVerify } from 'jose';

const ATH_ISSUER = process.env.ATH_ISSUER ?? 'https://auth.internal.keybank.example';
const jwks = createRemoteJWKSet(new URL(\`\${ATH_ISSUER}/.well-known/jwks.json\`), {
  cacheMaxAge: 10 * 60_000,
});

declare module 'fastify' {
  interface FastifyRequest {
    customerId: string;
  }
}

/** Verifies the app's bearer token on every /mobile route. The apps refresh tokens themselves. */
export default fp(async (app: FastifyInstance) => {
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/mobile/')) return;
    const token = request.headers.authorization?.replace(/^Bearer /, '');
    if (!token) return reply.code(401).send({ code: 'UNAUTHENTICATED' });

    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: ATH_ISSUER,
        audience: 'keybank-apis',
        clockTolerance: 5,
      });
      request.customerId = payload.sub!;
    } catch (err) {
      if (err instanceof errors.JWTExpired) {
        const { iat, exp } = err.payload;
        request.log.warn(
          {
            err,
            appVersion: request.headers['x-app-version'],
            platform: request.headers['x-platform'],
            tokenLifetimeSec: iat && exp ? exp - iat : undefined,
          },
          'access token rejected: expired',
        );
        return reply.code(401).send({ code: 'SESSION_EXPIRED' });
      }
      request.log.warn({ err }, 'access token rejected');
      return reply.code(401).send({ code: 'UNAUTHENTICATED' });
    }
  });
});
`;

export const mblOverlay: RepoOverlay = {
  complete: false,
  files: {
    [MBL_PATHS.profileClient]: MBL_PROFILE_CLIENT,
    [MBL_PATHS.cardClient]: MBL_CARD_CLIENT,
    [MBL_PATHS.authPlugin]: MBL_AUTH_PLUGIN,
  },
};
