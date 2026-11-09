import type { RepoOverlay } from '../types';
import { NODE_TSCONFIG, nodePackageJson } from './common';

/** keybank/ABA00/routing-directory-service: routing number validation and FI lookup. */
export const ABA_REPO = 'keybank/ABA00/routing-directory-service';

export const ABA_PATHS = {
  checksum: 'src/services/checksum.ts',
  checksumTest: 'test/checksum.test.ts',
  routes: 'src/routes/routingNumbers.ts',
} as const;

const PACKAGE_JSON = nodePackageJson({
  name: 'routing-directory-service',
  version: '1.19.0',
  description: 'ABA routing number validation and FedACH / Fedwire directory lookup (ABA).',
  dependencies: {
    '@google-cloud/storage': '7.14.0',
    fastify: '5.1.0',
    pino: '9.5.0',
    zod: '3.23.8',
  },
});

const CONFIG = `function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

export const config = {
  port: Number(env('PORT', '8080')),
  logLevel: env('LOG_LEVEL', 'info'),
  /** FedACH participant directory, refreshed nightly from the Fed E-Payments Routing Directory. */
  directoryBucket: env('DIRECTORY_BUCKET', 'kb-prod-aba00-routing-directory'),
  directoryObject: env('DIRECTORY_OBJECT', 'fedach/FedACHdir.txt'),
  /** How often to re-read the directory file (ms). */
  directoryRefreshMs: Number(env('DIRECTORY_REFRESH_MS', String(6 * 60 * 60 * 1000))),
};
`;

const INDEX = `import { Storage } from '@google-cloud/storage';
import Fastify from 'fastify';
import { config } from './config';
import { routingNumberRoutes } from './routes/routingNumbers';
import { RoutingDirectory } from './services/directory';

const app = Fastify({ logger: { level: config.logLevel }, trustProxy: true });
const storage = new Storage();

async function loadDirectory(): Promise<RoutingDirectory> {
  const [contents] = await storage
    .bucket(config.directoryBucket)
    .file(config.directoryObject)
    .download();
  const directory = RoutingDirectory.parse(contents.toString('latin1'));
  app.log.info({ institutions: directory.size }, 'FedACH directory loaded');
  return directory;
}

let directory = await loadDirectory();
setInterval(() => {
  loadDirectory()
    .then((next) => {
      directory = next;
    })
    .catch((err) => app.log.error({ err }, 'FedACH directory refresh failed; keeping previous copy'));
}, config.directoryRefreshMs).unref();

await app.register(routingNumberRoutes, { directory: () => directory });
app.get('/healthz', async () => ({ status: 'ok', institutions: directory.size }));

await app.listen({ host: '0.0.0.0', port: config.port });
`;

export const ABA_ROUTES = `import type { FastifyInstance } from 'fastify';
import { isValidAbaChecksum, isWellFormed } from '../services/checksum';
import type { RoutingDirectory } from '../services/directory';

type Reason = 'MALFORMED' | 'CHECKSUM_MISMATCH' | 'NOT_IN_DIRECTORY' | 'INACTIVE';

interface ValidationResult {
  routingNumber: string;
  valid: boolean;
  reason?: Reason;
  institution?: { name: string; city: string; state: string };
}

export async function routingNumberRoutes(
  app: FastifyInstance,
  opts: { directory: () => RoutingDirectory },
) {
  /** Used by ACH, WIR, BPY and PAY before accepting a routing number. Always 200. */
  app.get<{ Params: { rtn: string } }>('/v1/routing-numbers/:rtn/validate', async (request) => {
    const { rtn } = request.params;
    const caller = request.headers['x-client-id'] ?? 'unknown';
    const result = validate(rtn, opts.directory());
    request.log.info(
      { rtn, valid: result.valid, reason: result.reason, caller },
      \`routing validation result rtn=\${rtn} valid=\${result.valid}\${result.reason ? \` reason=\${result.reason}\` : ''} caller=\${caller}\`,
    );
    return result;
  });

  app.get<{ Params: { rtn: string } }>('/v1/routing-numbers/:rtn', async (request, reply) => {
    const institution = opts.directory().lookup(request.params.rtn);
    if (!institution) return reply.code(404).send({ error: 'routing number not found' });
    return institution;
  });
}

function validate(rtn: string, directory: RoutingDirectory): ValidationResult {
  if (!isWellFormed(rtn)) return { routingNumber: rtn, valid: false, reason: 'MALFORMED' };
  if (!isValidAbaChecksum(rtn)) {
    return { routingNumber: rtn, valid: false, reason: 'CHECKSUM_MISMATCH' };
  }
  const institution = directory.lookup(rtn);
  if (!institution) return { routingNumber: rtn, valid: false, reason: 'NOT_IN_DIRECTORY' };
  if (institution.newRoutingNumber) {
    return { routingNumber: rtn, valid: false, reason: 'INACTIVE' };
  }
  const { name, city, state } = institution;
  return { routingNumber: rtn, valid: true, institution: { name, city, state } };
}
`;

/** The block the "optimize" MR rewrites. */
export const ABA_CHECKSUM_ORIGINAL_BLOCK = `const WEIGHTS = [3, 7, 1, 3, 7, 1, 3, 7, 1] as const;

export function isValidAbaChecksum(rtn: string): boolean {
  if (!isWellFormed(rtn)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += Number(rtn[i]) * WEIGHTS[i]!;
  }
  return sum % 10 === 0;
}`;

export const ABA_BAD_SUM_LINE = '    sum += 3 * a + 7 * c + b;';

export const ABA_CHECKSUM_OPTIMIZED_BLOCK = `const ZERO = 48; // '0'

/**
 * Hot path for ACH file validation (called once per entry detail record), so no regex and no
 * per-digit Number() allocation. Digits are processed in weight groups of three.
 */
export function isValidAbaChecksum(rtn: string): boolean {
  if (rtn.length !== 9) return false;
  let sum = 0;
  for (let i = 0; i < 9; i += 3) {
    const a = rtn.charCodeAt(i) - ZERO;
    const b = rtn.charCodeAt(i + 1) - ZERO;
    const c = rtn.charCodeAt(i + 2) - ZERO;
    if (a < 0 || a > 9 || b < 0 || b > 9 || c < 0 || c > 9) return false;
${ABA_BAD_SUM_LINE}
  }
  return sum % 10 === 0;
}`;

export const ABA_CHECKSUM = `/**
 * ABA routing transit number (RTN) validation.
 *
 * The ninth digit is a check digit: 3 x (d1 + d4 + d7) + 7 x (d2 + d5 + d8) + 1 x (d3 + d6 + d9)
 * must be a multiple of 10 (ABA Key to Routing Numbers, "Check digit routine").
 */

const RTN_PATTERN = /^\\d{9}$/;

/** Nine digits, nothing else. */
export function isWellFormed(rtn: string): boolean {
  return RTN_PATTERN.test(rtn);
}

${ABA_CHECKSUM_ORIGINAL_BLOCK}

/** First four digits: Federal Reserve routing symbol (district + institution type). */
export function routingSymbol(rtn: string): string {
  return rtn.slice(0, 4);
}

/** Federal Reserve district (1-12) a routing number belongs to. */
export function federalReserveDistrict(rtn: string): number {
  const prefix = Number(rtn.slice(0, 2));
  // 21-32: thrift institutions in districts 1-12. 61-72: electronic transaction identifiers.
  if (prefix >= 21 && prefix <= 32) return prefix - 20;
  if (prefix >= 61 && prefix <= 72) return prefix - 60;
  return prefix;
}
`;

const DIRECTORY = `/**
 * FedACH participant directory (Fed E-Payments Routing Directory, fixed-width format,
 * 155 characters per record).
 */
export interface Institution {
  routingNumber: string;
  officeCode: 'O' | 'B';
  recordType: '0' | '1' | '2';
  name: string;
  city: string;
  state: string;
  /** Set when the routing number was merged into another one (record type 2). */
  newRoutingNumber?: string;
}

export class RoutingDirectory {
  private constructor(private readonly byRtn: Map<string, Institution>) {}

  static parse(text: string): RoutingDirectory {
    const byRtn = new Map<string, Institution>();
    for (const line of text.split(/\\r?\\n/)) {
      if (line.length < 150) continue;
      const recordType = line.slice(19, 20) as Institution['recordType'];
      const newRtn = line.slice(26, 35);
      byRtn.set(line.slice(0, 9), {
        routingNumber: line.slice(0, 9),
        officeCode: line.slice(9, 10) as Institution['officeCode'],
        recordType,
        name: line.slice(35, 71).trim(),
        city: line.slice(107, 127).trim(),
        state: line.slice(127, 129),
        newRoutingNumber: recordType === '2' && newRtn !== '000000000' ? newRtn : undefined,
      });
    }
    return new RoutingDirectory(byRtn);
  }

  lookup(rtn: string): Institution | undefined {
    return this.byRtn.get(rtn);
  }

  get size(): number {
    return this.byRtn.size;
  }
}
`;

/** Routing numbers from the published directory used by the original unit tests. */
const PUBLISHED_TEST_BLOCK = `  // Routing numbers taken from the published Fed E-Payments Routing Directory.
  it.each([
    '011000015',
    '021000021',
    '031000095',
    '041001039',
    '044000037',
    '051000017',
    '061000146',
    '071000013',
    '113000023',
    '121000248',
  ])('accepts published routing number %s', (rtn) => {
    expect(isValidAbaChecksum(rtn)).toBe(true);
  });

  it.each(['041001038', '021000012', '123456789'])('rejects bad check digit %s', (rtn) => {
    expect(isValidAbaChecksum(rtn)).toBe(false);
  });
`;

const PROPERTY_TEST_BLOCK = `  // Property-based instead of a hand-maintained list: for any 8-digit prefix exactly one check
  // digit makes the routing number valid.
  it('accepts exactly one check digit per prefix', () => {
    for (let n = 0; n < 5_000; n++) {
      const prefix = String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0');
      const valid = [...'0123456789'].filter((d) => isValidAbaChecksum(prefix + d));
      expect(valid).toHaveLength(1);
    }
  });
`;

const checksumTest = (block: string) => `import { describe, expect, it } from 'vitest';
import { federalReserveDistrict, isValidAbaChecksum } from '../src/services/checksum';

describe('isValidAbaChecksum', () => {
${block}
  it.each(['', '04100103', '0410010399', '04100103X', ' 41001039'])(
    'rejects malformed input %j',
    (rtn) => {
      expect(isValidAbaChecksum(rtn)).toBe(false);
    },
  );
});

describe('federalReserveDistrict', () => {
  it('maps thrift and ETC prefixes back to their district', () => {
    expect(federalReserveDistrict('041001039')).toBe(4);
    expect(federalReserveDistrict('241070417')).toBe(4);
    expect(federalReserveDistrict('641000012')).toBe(4);
  });
});
`;

export const ABA_CHECKSUM_TEST = checksumTest(PUBLISHED_TEST_BLOCK);
export const ABA_CHECKSUM_TEST_BAD = checksumTest(PROPERTY_TEST_BLOCK);
/** The fix keeps the property test and restores the published vectors. */
export const ABA_FIX_TEST_FIND = PROPERTY_TEST_BLOCK;
export const ABA_FIX_TEST_REPLACE = `${PUBLISHED_TEST_BLOCK}
${PROPERTY_TEST_BLOCK}`;

const DIRECTORY_TEST = `import { describe, expect, it } from 'vitest';
import { RoutingDirectory } from '../src/services/directory';

function record(rtn: string, name: string, city: string, state: string, type = '1', newRtn = '000000000') {
  return (
    rtn +
    'O' +
    '011000015' +
    type +
    '010125' +
    newRtn +
    name.padEnd(36) +
    '100 MAIN ST'.padEnd(36) +
    city.padEnd(20) +
    state +
    '44114' +
    '0000' +
    '2165550100' +
    '1' +
    '1' +
    '     '
  );
}

describe('RoutingDirectory.parse', () => {
  it('parses fixed-width FedACH records', () => {
    const dir = RoutingDirectory.parse(
      [
        record('041001039', 'LAKESHORE NATIONAL BANK', 'CLEVELAND', 'OH'),
        record('041000124', 'NORTH COAST SAVINGS', 'AKRON', 'OH', '2', '041001039'),
      ].join('\\n'),
    );

    expect(dir.size).toBe(2);
    expect(dir.lookup('041001039')).toMatchObject({ name: 'LAKESHORE NATIONAL BANK', state: 'OH' });
    expect(dir.lookup('041000124')?.newRoutingNumber).toBe('041001039');
  });
});
`;

export const abaOverlay: RepoOverlay = {
  complete: true,
  files: {
    'package.json': PACKAGE_JSON,
    'tsconfig.json': NODE_TSCONFIG,
    'src/index.ts': INDEX,
    'src/config.ts': CONFIG,
    [ABA_PATHS.routes]: ABA_ROUTES,
    [ABA_PATHS.checksum]: ABA_CHECKSUM,
    'src/services/directory.ts': DIRECTORY,
    [ABA_PATHS.checksumTest]: ABA_CHECKSUM_TEST,
    'test/directory.test.ts': DIRECTORY_TEST,
  },
};
