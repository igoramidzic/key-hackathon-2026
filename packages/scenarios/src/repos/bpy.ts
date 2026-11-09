import type { RepoOverlay } from '../types';

/** keybank/BPY00/billpay-service: payees and scheduled bill payments. */
export const BPY_REPO = 'keybank/BPY00/billpay-service';

export const BPY_PATHS = {
  routingClient: 'src/clients/routingDirectoryClient.ts',
  profileClient: 'src/clients/customerProfileClient.ts',
  payeeRoutes: 'src/routes/payees.ts',
} as const;

const ROUTING_CLIENT = `const ABA_BASE_URL = process.env.ABA_BASE_URL ?? 'https://aba.internal.keybank.example';

export interface RoutingValidation {
  routingNumber: string;
  valid: boolean;
  reason?: 'MALFORMED' | 'CHECKSUM_MISMATCH' | 'NOT_IN_DIRECTORY' | 'INACTIVE';
  institution?: { name: string; city: string; state: string };
}

export async function validateRoutingNumber(rtn: string): Promise<RoutingValidation> {
  const res = await fetch(\`\${ABA_BASE_URL}/v1/routing-numbers/\${encodeURIComponent(rtn)}/validate\`, {
    headers: { 'x-client-id': 'billpay-service' },
    signal: AbortSignal.timeout(1_500),
  });
  if (!res.ok) throw new Error(\`routing-directory-service responded \${res.status}\`);
  return (await res.json()) as RoutingValidation;
}
`;

const PROFILE_CLIENT = `const CIF_BASE_URL = process.env.CIF_BASE_URL ?? 'https://cif.internal.keybank.example';

export interface CustomerProfile {
  customerId: string;
  firstName: string;
  lastName: string;
  kycStatus: string;
}

export async function getProfile(customerId: string, token: string): Promise<CustomerProfile> {
  const res = await fetch(\`\${CIF_BASE_URL}/v1/customers/\${encodeURIComponent(customerId)}/profile\`, {
    headers: { authorization: \`Bearer \${token}\` },
    signal: AbortSignal.timeout(2_000),
  });
  if (!res.ok) throw new Error(\`customer-profile-api responded \${res.status}\`);
  return (await res.json()) as CustomerProfile;
}
`;

export const BPY_PAYEE_ROUTES = `import type { FastifyInstance } from 'fastify';
import { getProfile } from '../clients/customerProfileClient';
import { validateRoutingNumber } from '../clients/routingDirectoryClient';

interface NewPayee {
  nickname: string;
  payeeName: string;
  routingNumber: string;
  accountNumber: string;
}

export async function payeeRoutes(app: FastifyInstance) {
  app.get('/v1/payees', async (request, reply) => {
    const { customerId, accessToken } = request.auth;
    const profile = await getProfile(customerId, accessToken);
    // Payees belong to the CIF customer; refuse if CIF disagrees about who this is.
    if (profile.customerId !== customerId) {
      request.log.error(
        { sessionCustomerId: customerId, cifCustomerId: profile.customerId },
        \`payee access denied: CIF customerId \${profile.customerId} does not match session customer \${customerId}\`,
      );
      return reply.code(403).send({ code: 'CUSTOMER_MISMATCH' });
    }
    return app.payees.list(customerId);
  });

  app.post<{ Body: NewPayee }>('/v1/payees', async (request, reply) => {
    const { routingNumber } = request.body;
    const aba = await validateRoutingNumber(routingNumber);
    if (!aba.valid) {
      request.log.warn(
        { routingNumber, reason: aba.reason },
        \`payee validation failed: routing number \${routingNumber} rejected by routing-directory-service (\${aba.reason})\`,
      );
      return reply.code(422).send({
        code: 'INVALID_ROUTING_NUMBER',
        message: 'Check the routing number and try again.',
      });
    }
    const payee = await app.payees.create(request.auth.customerId, request.body, aba.institution);
    return reply.code(201).send(payee);
  });
}
`;

export const bpyOverlay: RepoOverlay = {
  complete: false,
  files: {
    [BPY_PATHS.routingClient]: ROUTING_CLIENT,
    [BPY_PATHS.profileClient]: PROFILE_CLIENT,
    [BPY_PATHS.payeeRoutes]: BPY_PAYEE_ROUTES,
  },
};
