import type { LogContext } from '@sim/scenarios';
import type { App, Rng } from '@sim/world';

/** Realistic random values. All draw from the given deterministic `Rng`. */

export const traceId = (rng: Rng) => rng.hex(32);
export const spanId = (rng: Rng) => rng.hex(16);

export const maskedAccount = (rng: Rng) => `****${rng.int(1000, 9999)}`;
export const customerId = (rng: Rng) => `C${rng.int(10_000_000, 99_999_999)}`;
export const accountNumber = (rng: Rng) => String(rng.int(1_000_000_000, 9_999_999_999));

export function uuid(rng: Rng): string {
  const h = rng.hex(32);
  const variant = '89ab'[rng.int(0, 3)];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** ABA routing number with a valid checksum (3-7-1 weighting). */
export function routingNumber(rng: Rng): string {
  const prefix = rng.chance(0.5) ? rng.int(1, 12) : rng.int(21, 32);
  const d = [...String(prefix).padStart(2, '0')].map(Number);
  for (let i = 0; i < 6; i++) d.push(rng.int(0, 9));
  const partial = 3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]!);
  d.push((10 - (partial % 10)) % 10);
  return d.join('');
}

export function isValidRouting(value: string): boolean {
  if (!/^\d{9}$/.test(value)) return false;
  const d = [...value].map(Number);
  const sum = 3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!);
  return sum % 10 === 0;
}

/** Log-uniform amount between $5 and $25,000, formatted `1,284.50`. */
export function amount(rng: Rng): string {
  const value = Math.exp(rng.float(Math.log(5), Math.log(25_000)));
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const internalIp = (rng: Rng) =>
  `10.${rng.int(32, 63)}.${rng.int(0, 255)}.${rng.int(2, 254)}`;

/** Approximately normal (mean 0, sd 1). */
export function gaussian(rng: Rng): number {
  let sum = 0;
  for (let i = 0; i < 6; i++) sum += rng.next();
  // Sum of 6 uniforms: mean 3, variance 0.5.
  return (sum - 3) / Math.SQRT1_2;
}

/** Lognormal latency around `baseMs`. */
export function latencyMs(rng: Rng, baseMs: number, spread = 0.35): number {
  return Math.max(1, Math.round(baseMs * Math.exp(gaussian(rng) * spread)));
}

export function makeLogContext(input: {
  rng: Rng;
  app: App;
  service: string;
  now: Date;
  elapsedSec: number;
}): LogContext {
  const { rng } = input;
  return {
    rng,
    app: input.app,
    service: input.service,
    now: input.now,
    elapsedSec: input.elapsedSec,
    traceId: () => traceId(rng),
    account: () => maskedAccount(rng),
    customerId: () => customerId(rng),
    requestId: () => uuid(rng),
    routingNumber: () => routingNumber(rng),
    amount: () => amount(rng),
  };
}
