/**
 * A practical subset of the Cloud Logging query language.
 *
 *   severity>=ERROR
 *   resource.labels.container_name="payments-api" OR labels.app_tla="ACH"
 *   jsonPayload.message:"timeout" -httpRequest.status<500
 *   NOT jsonPayload.error.type=~"^Socket" "connection reset"
 *
 * - Comparisons: `=`, `!=`, `:` (has: case-insensitive substring; `field:*` = present),
 *   `=~` / `!~` (regex), `>`, `>=`, `<`, `<=`. Severity compares by rank, timestamps by time,
 *   numbers (and durations like `1.5s`) numerically.
 * - `AND`, `OR`, `NOT`, leading `-`, parentheses; adjacent terms (and lines) are ANDed.
 *   Like GCP, OR binds tighter than AND: `a b OR c` means `a AND (b OR c)`.
 * - Value lists: `labels.app_tla=("PAY" OR "ACH")`.
 * - Bare words / quoted strings search message, payload, URL and labels.
 * - `--` starts a comment that runs to the end of the line.
 */
import { type LogEntry, logMessage, SEVERITIES, type Severity } from '@sim/contracts/logs';

export type CompareOp = '=' | '!=' | ':' | '=~' | '!~' | '>' | '>=' | '<' | '<=';

export type FilterNode =
  | { type: 'and'; children: FilterNode[] }
  | { type: 'or'; children: FilterNode[] }
  | { type: 'not'; child: FilterNode }
  | { type: 'compare'; field: string; op: CompareOp; values: string[]; pos: number }
  | { type: 'text'; value: string };

export type Predicate = (entry: LogEntry) => boolean;

export class FilterSyntaxError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
    this.name = 'FilterSyntaxError';
  }
}

export const SEVERITY_RANK: Record<Severity, number> = Object.fromEntries(
  SEVERITIES.map((s, i) => [s, i]),
) as Record<Severity, number>;

// ---------------------------------------------------------------------------
// Parser (scannerless recursive descent; values after an operator are lexed permissively)
// ---------------------------------------------------------------------------

const OPERATORS: CompareOp[] = ['>=', '<=', '!=', '=~', '!~', '=', ':', '>', '<'];
const OP_CHARS = new Set(['=', '!', '<', '>', ':']);
const WS = /\s/;
const FIELD_RE = /^[A-Za-z_@][\w@-]*(\.[\w@-]+)*$/;

class Parser {
  private i = 0;

  constructor(private readonly src: string) {}

  parse(): FilterNode | null {
    this.skip();
    if (this.eof()) return null;
    const node = this.parseAnd();
    this.skip();
    if (!this.eof()) throw this.error(`Unexpected "${this.src[this.i]}"`);
    return node;
  }

  // AND (explicit or implicit) has the lowest precedence.
  private parseAnd(): FilterNode {
    const children = [this.parseOr()];
    for (;;) {
      this.skip();
      if (this.eof() || this.peek() === ')') break;
      if (this.keyword('AND')) {
        this.skip();
        if (this.eof() || this.peek() === ')') throw this.error('Expected an expression after AND');
      }
      children.push(this.parseOr());
    }
    return children.length === 1 ? children[0]! : { type: 'and', children };
  }

  private parseOr(): FilterNode {
    const children = [this.parseUnary()];
    for (;;) {
      const save = this.i;
      this.skip();
      if (!this.keyword('OR')) {
        this.i = save;
        break;
      }
      this.skip();
      if (this.eof() || this.peek() === ')') throw this.error('Expected an expression after OR');
      children.push(this.parseUnary());
    }
    return children.length === 1 ? children[0]! : { type: 'or', children };
  }

  private parseUnary(): FilterNode {
    this.skip();
    if (this.keyword('NOT')) {
      this.skip();
      if (this.eof() || this.peek() === ')') throw this.error('Expected an expression after NOT');
      return { type: 'not', child: this.parseUnary() };
    }
    if (this.peek() === '-' && this.i + 1 < this.src.length && !WS.test(this.src[this.i + 1]!)) {
      this.i++;
      return { type: 'not', child: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): FilterNode {
    this.skip();
    if (this.eof()) throw this.error('Unexpected end of filter');
    const ch = this.peek();
    if (ch === '(') {
      const open = this.i;
      this.i++;
      this.skip();
      if (this.peek() === ')') throw this.error('Empty parentheses');
      const node = this.parseAnd();
      this.skip();
      if (this.peek() !== ')') throw new FilterSyntaxError('Missing closing ")"', open);
      this.i++;
      return node;
    }
    if (ch === ')') throw this.error('Unexpected ")"');
    if (ch === '"' || ch === "'") return { type: 'text', value: this.readString() };
    if (OP_CHARS.has(ch)) {
      const op = this.peekOperator() ?? ch;
      throw this.error(`Expected a field name before "${op}"`);
    }
    for (const kw of ['AND', 'OR']) {
      if (this.peekKeyword(kw)) {
        throw this.error(`Unexpected ${kw}: expected a comparison or search term`);
      }
    }

    const start = this.i;
    const word = this.readWord();
    const afterWord = this.i;
    this.skip();
    const op = this.peekOperator();
    if (!op) {
      this.i = afterWord;
      return { type: 'text', value: word };
    }
    if (!FIELD_RE.test(word)) {
      throw new FilterSyntaxError(`Invalid field name "${word}"`, start);
    }
    const opPos = this.i;
    this.i += op.length;
    const values = this.parseValues(op);
    return { type: 'compare', field: word, op, values, pos: opPos };
  }

  private parseValues(op: string): string[] {
    this.skip();
    if (this.eof()) throw this.error(`Expected a value after "${op}"`);
    if (this.peek() !== '(') return [this.readValue(op)];
    const open = this.i;
    this.i++;
    const values = [this.readValue(op)];
    for (;;) {
      this.skip();
      if (this.eof()) throw new FilterSyntaxError('Missing closing ")" in value list', open);
      if (this.peek() === ')') {
        this.i++;
        return values;
      }
      if (!this.keyword('OR')) throw this.error('Expected OR or ")" in value list');
      values.push(this.readValue(op));
    }
  }

  private readValue(op: string): string {
    this.skip();
    if (this.eof()) throw this.error(`Expected a value after "${op}"`);
    const ch = this.peek();
    if (ch === '"' || ch === "'") return this.readString();
    const start = this.i;
    while (!this.eof() && !WS.test(this.peek()) && this.peek() !== ')' && this.peek() !== '(') {
      this.i++;
    }
    if (this.i === start) throw this.error(`Expected a value after "${op}"`);
    return this.src.slice(start, this.i);
  }

  private readWord(): string {
    const start = this.i;
    while (!this.eof()) {
      const ch = this.peek();
      if (WS.test(ch) || ch === '(' || ch === ')' || ch === '"' || ch === "'" || OP_CHARS.has(ch)) {
        break;
      }
      this.i++;
    }
    if (this.i === start) throw this.error(`Unexpected "${this.peek()}"`);
    return this.src.slice(start, this.i);
  }

  private readString(): string {
    const quote = this.peek();
    const start = this.i;
    this.i++;
    let out = '';
    while (!this.eof()) {
      const ch = this.src[this.i++]!;
      if (ch === quote) return out;
      if (ch === '\\' && !this.eof()) {
        // \" \' \\ \n \t are escapes; anything else (e.g. regex \d) keeps its backslash.
        const next = this.src[this.i++]!;
        if (next === 'n') out += '\n';
        else if (next === 't') out += '\t';
        else if (next === quote || next === '\\') out += next;
        else out += `\\${next}`;
      } else {
        out += ch;
      }
    }
    throw new FilterSyntaxError('Unterminated string', start);
  }

  private peekOperator(): CompareOp | undefined {
    return OPERATORS.find((op) => this.src.startsWith(op, this.i));
  }

  private peekKeyword(kw: string): boolean {
    const end = this.i + kw.length;
    if (this.src.slice(this.i, end).toUpperCase() !== kw) return false;
    const next = this.src[end];
    return next === undefined || WS.test(next) || next === '(' || next === '"';
  }

  private keyword(kw: string): boolean {
    if (!this.peekKeyword(kw)) return false;
    this.i += kw.length;
    return true;
  }

  /** Skips whitespace and `--` comments. */
  private skip() {
    for (;;) {
      while (!this.eof() && WS.test(this.peek())) this.i++;
      if (this.src.startsWith('--', this.i)) {
        while (!this.eof() && this.peek() !== '\n') this.i++;
        continue;
      }
      return;
    }
  }

  private peek(): string {
    return this.src[this.i] ?? '';
  }

  private eof(): boolean {
    return this.i >= this.src.length;
  }

  private error(message: string) {
    return new FilterSyntaxError(message, this.i);
  }
}

export function parseFilter(src: string): FilterNode | null {
  return new Parser(src).parse();
}

/** "line 2, col 5" for a 0-based offset. */
export function describePosition(src: string, position: number): string {
  const before = src.slice(0, position);
  const line = before.split('\n').length;
  const col = position - before.lastIndexOf('\n');
  return `line ${line}, col ${col}`;
}

/** Human-readable parse error for API responses. */
export function formatFilterError(src: string, err: FilterSyntaxError): string {
  return `Invalid filter: ${err.message} (${describePosition(src, err.position)})`;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Shortcuts beyond GCP field paths. */
const ALIASES: Record<string, string> = {
  service: 'resource.labels.container_name',
  container: 'resource.labels.container_name',
  app_tla: 'labels.app_tla',
  tla: 'labels.app_tla',
  status: 'httpRequest.status',
};

const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const DURATION_RE = /^(-?\d+(?:\.\d+)?)s$/;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return undefined;
  if (NUMBER_RE.test(value)) return Number(value);
  const d = value.match(DURATION_RE);
  return d ? Number(d[1]) : undefined;
}

function deepTest(value: unknown, re: RegExp, depth = 0): boolean {
  if (value === null || value === undefined || depth > 8) return false;
  if (typeof value === 'string') return re.test(value);
  if (typeof value === 'number' || typeof value === 'boolean') return re.test(String(value));
  if (Array.isArray(value)) return value.some((v) => deepTest(v, re, depth + 1));
  if (typeof value === 'object') {
    for (const v of Object.values(value)) if (deepTest(v, re, depth + 1)) return true;
  }
  return false;
}

/** Global (bare word) search: payloads, request URL, service and labels. */
export function textMatches(entry: LogEntry, re: RegExp): boolean {
  if (entry.textPayload && re.test(entry.textPayload)) return true;
  if (entry.jsonPayload && deepTest(entry.jsonPayload, re)) return true;
  if (entry.httpRequest?.requestUrl && re.test(entry.httpRequest.requestUrl)) return true;
  if (re.test(entry.resource?.labels?.container_name ?? '')) return true;
  if (entry.labels) for (const v of Object.values(entry.labels)) if (re.test(v)) return true;
  return false;
}

export function textPredicate(text: string): Predicate {
  const re = new RegExp(escapeRegExp(text), 'i');
  return (entry) => textMatches(entry, re);
}

function resolver(field: string): (entry: LogEntry) => unknown {
  if (field === 'message') return (e) => logMessage(e);
  const path = (ALIASES[field] ?? field).split('.');
  return (entry) => {
    let cur: unknown = entry;
    for (const seg of path) {
      if (cur === null || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
    return cur;
  };
}

function parseSeverityValue(value: string, pos: number): number {
  const upper = value.toUpperCase();
  if (upper in SEVERITY_RANK) return SEVERITY_RANK[upper as Severity];
  // GCP numeric codes: DEFAULT=0, DEBUG=100 … EMERGENCY=800.
  if (NUMBER_RE.test(value)) {
    const n = Number(value);
    if (n % 100 === 0 && n >= 0 && n <= 800) return n / 100;
  }
  throw new FilterSyntaxError(
    `Unknown severity "${value}" (expected one of ${SEVERITIES.join(', ')})`,
    pos,
  );
}

function compileRegex(value: string, pos: number): RegExp {
  try {
    return new RegExp(value);
  } catch (err) {
    throw new FilterSyntaxError(
      `Invalid regular expression "${value}": ${err instanceof Error ? err.message : err}`,
      pos,
    );
  }
}

type ValueTest = (actual: unknown) => boolean;

function orderTest(op: CompareOp, cmp: (actual: unknown) => number | undefined): ValueTest {
  return (actual) => {
    const c = cmp(actual);
    if (c === undefined || Number.isNaN(c)) return false;
    switch (op) {
      case '=':
      case ':':
        return c === 0;
      case '>':
        return c > 0;
      case '>=':
        return c >= 0;
      case '<':
        return c < 0;
      case '<=':
        return c <= 0;
      default:
        return false;
    }
  };
}

function compileValueTest(field: string, op: CompareOp, value: string, pos: number): ValueTest {
  const resolvedField = ALIASES[field] ?? field;

  if (resolvedField === 'severity') {
    if (op === '=~') {
      const re = compileRegex(value, pos);
      return (actual) => typeof actual === 'string' && re.test(actual);
    }
    const rank = parseSeverityValue(value, pos);
    return orderTest(op, (actual) =>
      typeof actual === 'string' && actual in SEVERITY_RANK
        ? SEVERITY_RANK[actual as Severity] - rank
        : undefined,
    );
  }

  if (resolvedField === 'timestamp' || resolvedField === 'receiveTimestamp') {
    if (op === ':') {
      return (actual) => typeof actual === 'string' && actual.includes(value);
    }
    if (op === '=~') {
      const re = compileRegex(value, pos);
      return (actual) => typeof actual === 'string' && re.test(actual);
    }
    const t = Date.parse(value);
    if (Number.isNaN(t)) {
      throw new FilterSyntaxError(
        `Invalid timestamp "${value}" (use ISO 8601, e.g. "2026-11-09T14:30:00Z")`,
        pos,
      );
    }
    return orderTest(op, (actual) =>
      typeof actual === 'string' ? Date.parse(actual) - t : undefined,
    );
  }

  if (op === ':') {
    if (value === '*') return (actual) => actual !== undefined && actual !== null;
    const re = new RegExp(escapeRegExp(value), 'i');
    return (actual) => deepTest(actual, re);
  }
  if (op === '=~') {
    const re = compileRegex(value, pos);
    return (actual) => deepTest(actual, re);
  }

  const num = toNumber(value);
  if (op === '=') {
    return (actual) => {
      if (Array.isArray(actual)) return actual.some((a) => a === value || String(a) === value);
      if (typeof actual === 'number') return num !== undefined && actual === num;
      if (typeof actual === 'boolean') return String(actual) === value.toLowerCase();
      return actual === value;
    };
  }

  // Ordering: numbers (and durations) numerically, everything else lexicographically.
  return orderTest(op, (actual) => {
    if (actual === null || actual === undefined || typeof actual === 'object') return undefined;
    const a = toNumber(actual);
    if (num !== undefined && a !== undefined) return a - num;
    const s = String(actual);
    return s === value ? 0 : s > value ? 1 : -1;
  });
}

function compileNode(node: FilterNode): Predicate {
  switch (node.type) {
    case 'and': {
      const preds = node.children.map(compileNode);
      return (e) => {
        for (const p of preds) if (!p(e)) return false;
        return true;
      };
    }
    case 'or': {
      const preds = node.children.map(compileNode);
      return (e) => {
        for (const p of preds) if (p(e)) return true;
        return false;
      };
    }
    case 'not': {
      const pred = compileNode(node.child);
      return (e) => !pred(e);
    }
    case 'text':
      return textPredicate(node.value);
    case 'compare': {
      const negate = node.op === '!=' || node.op === '!~';
      const op: CompareOp = node.op === '!=' ? '=' : node.op === '!~' ? '=~' : node.op;
      const get = resolver(node.field);
      const tests = node.values.map((v) => compileValueTest(node.field, op, v, node.pos));
      return (e) => {
        const actual = get(e);
        let hit = false;
        for (const t of tests) {
          if (t(actual)) {
            hit = true;
            break;
          }
        }
        return negate ? !hit : hit;
      };
    }
  }
}

/** Parses and compiles a filter. Empty filters match everything. Throws FilterSyntaxError. */
export function compileFilter(src: string | undefined): Predicate {
  const ast = src ? parseFilter(src) : null;
  return ast ? compileNode(ast) : () => true;
}
