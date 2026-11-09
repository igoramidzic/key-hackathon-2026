import { hashString } from '@sim/world';

/**
 * Normalizes a log message into a pattern so that lines differing only in ids, amounts,
 * durations or quoted values group together:
 *   `Timeout after 3000ms calling cif for C10458213` → `Timeout after <n>ms calling cif for C<n>`
 */
const RULES: [RegExp, string][] = [
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g, '<email>'],
  [/https?:\/\/[^\s"']+/g, '<url>'],
  [/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, '<ip>'],
  [/"[^"]*"/g, '"<str>"'],
  [/'[^']*'/g, "'<str>'"],
  [/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\b/g, '<time>'],
  // Account masks: ****4821, XXXX4821, x4821
  [/(\*{2,}|\bX{2,}|\bx)\d{2,}\b/g, '<acct>'],
  // Lowercase hex ids (8+ chars mixing digits and a-f), e.g. trace ids, shas, pod hashes.
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/g, '<hex>'],
  // Amounts and plain numbers (incl. 1,284.50).
  [/\d[\d,]*(\.\d+)?/g, '<n>'],
];

export function normalizeMessage(message: string): string {
  let out = message.length > 2000 ? message.slice(0, 2000) : message;
  // Only the first line matters for grouping (stack traces vary).
  const nl = out.indexOf('\n');
  if (nl >= 0) out = out.slice(0, nl);
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return out.replace(/\s+/g, ' ').trim();
}

export function fingerprintOf(appTla: string, service: string, pattern: string): string {
  return hashString(`${appTla}|${service}|${pattern}`).toString(16).padStart(8, '0').slice(-8);
}
