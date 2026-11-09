import type { RepoOverlay } from '../types';

/** keybank/OLB00/online-banking-bff: backend-for-frontend of the online banking SPA. */
export const OLB_REPO = 'keybank/OLB00/online-banking-bff';

export const OLB_PATHS = {
  profileClient: 'src/clients/customerProfileClient.ts',
  profileRoutes: 'src/routes/profile.ts',
  authClient: 'src/clients/authTokenClient.ts',
} as const;

export const OLB_PROFILE_CLIENT = `import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';

const CIF_BASE_URL = process.env.CIF_BASE_URL ?? 'https://cif.internal.keybank.example';
const TIMEOUT_MS = 2_500;

/** Contract for GET /v1/customers/{customerId}/profile on customer-profile-api (CIF). */
export const customerProfileSchema = z.object({
  customerId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  primaryEmail: z.string().email().optional(),
  mobilePhone: z.string().optional(),
  mailingAddress: z
    .object({
      line1: z.string(),
      line2: z.string().optional(),
      city: z.string(),
      state: z.string().length(2),
      postalCode: z.string(),
    })
    .optional(),
  segment: z.enum(['RETAIL', 'PREMIER', 'PRIVATE', 'SMALL_BUSINESS']),
  kycStatus: z.string(),
  contactPreferences: z
    .object({
      email: z.boolean(),
      sms: z.boolean(),
      push: z.boolean(),
      preferredChannel: z.string(),
    })
    .optional(),
  customerSince: z.string(),
});

export type CustomerProfile = z.infer<typeof customerProfileSchema>;

/** CIF answered 2xx but the body does not match the contract. Surfaced to the browser as 502. */
export class UpstreamContractError extends Error {
  readonly statusCode = 502;

  constructor(
    readonly upstream: string,
    readonly issues: z.ZodIssue[],
    readonly receivedKeys: string[],
  ) {
    super(\`\${upstream} response failed contract validation\`);
    this.name = 'UpstreamContractError';
  }
}

export class CustomerProfileClient {
  constructor(
    private readonly log: FastifyBaseLogger,
    private readonly baseUrl = CIF_BASE_URL,
  ) {}

  async getProfile(customerId: string, accessToken: string): Promise<CustomerProfile> {
    const url = \`\${this.baseUrl}/v1/customers/\${encodeURIComponent(customerId)}/profile\`;
    const res = await fetch(url, {
      headers: { authorization: \`Bearer \${accessToken}\`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(\`customer-profile-api responded \${res.status}\`);

    const body: unknown = await res.json();
    const parsed = customerProfileSchema.safeParse(body);
    if (!parsed.success) {
      const receivedKeys = body && typeof body === 'object' ? Object.keys(body) : [];
      this.log.error(
        {
          upstream: 'customer-profile-api',
          upstreamStatus: res.status,
          receivedKeys,
          issues: parsed.error.issues,
        },
        'CIF profile response failed schema validation',
      );
      throw new UpstreamContractError('customer-profile-api', parsed.error.issues, receivedKeys);
    }
    return parsed.data;
  }
}
`;

/** The user-facing copy line (the red-herring copy change edits exactly this line). */
export const OLB_PROFILE_COPY_LINE =
  "  'We could not load your profile right now. Please try again in a few minutes.';";

export const OLB_PROFILE_ROUTES = `import type { FastifyInstance } from 'fastify';
import { CustomerProfileClient, UpstreamContractError } from '../clients/customerProfileClient';

const PROFILE_UNAVAILABLE_COPY =
${OLB_PROFILE_COPY_LINE}

export async function profileRoutes(app: FastifyInstance) {
  const cif = new CustomerProfileClient(app.log);

  /** Profile & settings page. */
  app.get('/bff/v1/profile', async (request, reply) => {
    const { customerId, accessToken } = request.session;
    try {
      const profile = await cif.getProfile(customerId, accessToken);
      return {
        displayName: \`\${profile.firstName} \${profile.lastName}\`,
        email: profile.primaryEmail,
        phone: profile.mobilePhone,
        address: profile.mailingAddress,
        segment: profile.segment,
        contactPreferences: profile.contactPreferences,
        customerSince: profile.customerSince,
      };
    } catch (err) {
      if (err instanceof UpstreamContractError) {
        request.log.error({ err, upstream: err.upstream }, 'profile unavailable: upstream contract violation');
        return reply.code(502).send({ code: 'PROFILE_UNAVAILABLE', message: PROFILE_UNAVAILABLE_COPY });
      }
      throw err;
    }
  });

  /** Dashboard header: greeting and segment badge. Accounts load separately. */
  app.get('/bff/v1/dashboard/header', async (request, reply) => {
    const { customerId, accessToken } = request.session;
    try {
      const { firstName, segment } = await cif.getProfile(customerId, accessToken);
      return { greetingName: firstName, segment };
    } catch (err) {
      if (err instanceof UpstreamContractError) {
        request.log.error({ err, upstream: err.upstream }, 'dashboard header unavailable: upstream contract violation');
        return reply.code(502).send({ code: 'PROFILE_UNAVAILABLE', message: PROFILE_UNAVAILABLE_COPY });
      }
      throw err;
    }
  });
}
`;

export const OLB_AUTH_CLIENT = `import type { FastifyBaseLogger } from 'fastify';

const ATH_BASE_URL = process.env.ATH_BASE_URL ?? 'https://auth.internal.keybank.example';
const CLIENT_ID = 'olb-bff';
/** Refresh this long before expiry so a token never expires in the middle of a request. */
const REFRESH_SKEW_MS = 30_000;

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
}

export class TokenRefreshError extends Error {
  constructor(
    readonly status: number,
    readonly oauthError: string,
  ) {
    super(\`token refresh failed: \${status} \${oauthError}\`);
    this.name = 'TokenRefreshError';
  }
}

/** Keeps the customer's tokens (held server-side in the BFF session) fresh. */
export class AuthTokenClient {
  constructor(
    private readonly log: FastifyBaseLogger,
    private readonly clientSecret = process.env.OLB_CLIENT_SECRET ?? '',
  ) {}

  async ensureFresh(tokens: SessionTokens): Promise<SessionTokens> {
    if (Date.now() < tokens.expiresAt - REFRESH_SKEW_MS) return tokens;
    return this.refresh(tokens.refreshToken);
  }

  async refresh(refreshToken: string): Promise<SessionTokens> {
    const basic = Buffer.from(\`\${CLIENT_ID}:\${this.clientSecret}\`).toString('base64');
    const res = await fetch(\`\${ATH_BASE_URL}/oauth2/token\`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: \`Basic \${basic}\`,
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new TokenRefreshError(res.status, body.error ?? 'unknown_error');
    }

    const body = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    if (body.expires_in * 1000 <= REFRESH_SKEW_MS) {
      this.log.warn(
        { expiresIn: body.expires_in, refreshSkewMs: REFRESH_SKEW_MS },
        'auth-token-service issued a token shorter than the refresh skew; every request will refresh',
      );
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + body.expires_in * 1000,
    };
  }
}
`;

export const olbOverlay: RepoOverlay = {
  complete: false,
  files: {
    [OLB_PATHS.profileClient]: OLB_PROFILE_CLIENT,
    [OLB_PATHS.profileRoutes]: OLB_PROFILE_ROUTES,
    [OLB_PATHS.authClient]: OLB_AUTH_CLIENT,
  },
};
