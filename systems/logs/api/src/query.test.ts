import type { LogEntry } from '@sim/contracts/logs';
import { describe, expect, it } from 'vitest';
import { compileFilter, FilterSyntaxError, formatFilterError, parseFilter } from './query';

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    insertId: 'abc123',
    seq: 1,
    logName: 'projects/kb-prod-pay00/logs/stdout',
    timestamp: '2026-11-09T14:30:00.000Z',
    receiveTimestamp: '2026-11-09T14:30:00.100Z',
    severity: 'ERROR',
    resource: {
      type: 'k8s_container',
      labels: {
        project_id: 'kb-prod-pay00',
        location: 'us-east4',
        cluster_name: 'gke-prod-use4-01',
        namespace_name: 'pay00',
        pod_name: 'payments-api-7d9f8-x2k4q',
        container_name: 'payments-api',
      },
    },
    labels: { app_tla: 'PAY', app_name: 'Payments Hub', env: 'prod', version: '4.2.1' },
    jsonPayload: {
      message: 'Timeout after 3000ms calling deposit-accounts-api for ****4821',
      logger: 'c.k.p.PaymentService',
      error: { type: 'java.net.SocketTimeoutException', message: 'Read timed out' },
      retries: 3,
      tags: ['wire', 'urgent'],
    },
    httpRequest: {
      requestMethod: 'POST',
      requestUrl: '/api/v1/payments',
      status: 504,
      latency: '3.012s',
    },
    trace: 'projects/kb-prod-pay00/traces/4bf92f3577b34da6a3ce929d0e0e4736',
    ...overrides,
  };
}

const info = entry({
  severity: 'INFO',
  jsonPayload: { message: 'Payment accepted id=PMT-1001' },
  httpRequest: { requestMethod: 'GET', requestUrl: '/health', status: 200, latency: '0.004s' },
  labels: { app_tla: 'ACH', app_name: 'ACH Origination', env: 'prod', version: '1.0.0' },
  resource: {
    ...entry().resource,
    labels: { ...entry().resource.labels, container_name: 'ach-api' },
  },
  trace: undefined,
});

const matches = (filter: string, e: LogEntry = entry()) => compileFilter(filter)(e);

describe('parseFilter', () => {
  it('returns null for empty filters and comments', () => {
    expect(parseFilter('')).toBeNull();
    expect(parseFilter('   \n  ')).toBeNull();
    expect(parseFilter('-- just a comment')).toBeNull();
  });

  it('parses comparisons with and without spaces', () => {
    expect(parseFilter('severity>=ERROR')).toEqual({
      type: 'compare',
      field: 'severity',
      op: '>=',
      values: ['ERROR'],
      pos: 8,
    });
    expect(parseFilter('severity >= "ERROR"')).toMatchObject({ op: '>=', values: ['ERROR'] });
  });

  it('gives OR higher precedence than AND (GCP semantics)', () => {
    const ast = parseFilter('a b OR c');
    expect(ast).toMatchObject({
      type: 'and',
      children: [
        { type: 'text', value: 'a' },
        {
          type: 'or',
          children: [
            { type: 'text', value: 'b' },
            { type: 'text', value: 'c' },
          ],
        },
      ],
    });
  });

  it('parses NOT, leading minus and parentheses', () => {
    expect(parseFilter('NOT severity=INFO')).toMatchObject({ type: 'not' });
    expect(parseFilter('-labels.app_tla=PAY')).toMatchObject({
      type: 'not',
      child: { type: 'compare', field: 'labels.app_tla' },
    });
    expect(parseFilter('(a OR b) AND c')).toMatchObject({ type: 'and' });
  });

  it('lexes values permissively after an operator', () => {
    expect(parseFilter('httpRequest.requestUrl:http://x/api?a=b')).toMatchObject({
      values: ['http://x/api?a=b'],
    });
    expect(parseFilter('timestamp>=2026-11-09T14:00:00Z')).toMatchObject({
      values: ['2026-11-09T14:00:00Z'],
    });
  });

  it('parses value lists', () => {
    expect(parseFilter('labels.app_tla=("PAY" OR ACH)')).toMatchObject({
      values: ['PAY', 'ACH'],
    });
  });

  it('handles escapes in strings', () => {
    expect(parseFilter('"say \\"hi\\""')).toEqual({ type: 'text', value: 'say "hi"' });
    expect(parseFilter('x=~"\\d+\\.\\d"')).toMatchObject({ values: ['\\d+\\.\\d'] });
  });

  it.each([
    ['severity>=', 'Expected a value after ">="'],
    ['(severity=ERROR', 'Missing closing ")"'],
    ['severity=ERROR)', 'Unexpected ")"'],
    ['"unterminated', 'Unterminated string'],
    ['=ERROR', 'Expected a field name before "="'],
    ['AND severity=ERROR', 'Unexpected AND'],
    ['a OR', 'Expected an expression after OR'],
    ['NOT', 'Expected an expression after NOT'],
    ['()', 'Empty parentheses'],
    ['labels.app_tla=(PAY ACH)', 'Expected OR or ")" in value list'],
  ])('rejects %j', (src, message) => {
    expect(() => parseFilter(src)).toThrow(FilterSyntaxError);
    expect(() => parseFilter(src)).toThrow(message);
  });

  it('reports line and column', () => {
    const src = 'severity>=ERROR\nlabels.app_tla=';
    try {
      parseFilter(src);
      expect.unreachable();
    } catch (err) {
      expect(formatFilterError(src, err as FilterSyntaxError)).toBe(
        'Invalid filter: Expected a value after "=" (line 2, col 16)',
      );
    }
  });
});

describe('compileFilter', () => {
  it('matches everything when empty', () => {
    expect(matches('')).toBe(true);
  });

  it('compares severity by rank, case-insensitively', () => {
    expect(matches('severity>=WARNING')).toBe(true);
    expect(matches('severity>=critical')).toBe(false);
    expect(matches('severity=ERROR')).toBe(true);
    expect(matches('severity<ERROR')).toBe(false);
    expect(matches('severity<=ERROR')).toBe(true);
    expect(matches('severity>=500')).toBe(true); // numeric GCP codes
    expect(matches('severity!=ERROR')).toBe(false);
  });

  it('rejects unknown severities', () => {
    expect(() => compileFilter('severity>=ERRORS')).toThrow('Unknown severity "ERRORS"');
  });

  it('supports dotted paths with = (exact) and : (case-insensitive substring)', () => {
    expect(matches('resource.labels.container_name="payments-api"')).toBe(true);
    expect(matches('resource.labels.container_name="payments"')).toBe(false);
    expect(matches('resource.labels.container_name:PAYMENTS')).toBe(true);
    expect(matches('labels.app_tla=PAY')).toBe(true);
    expect(matches('jsonPayload.message:"timeout after"')).toBe(true);
    expect(matches('jsonPayload.error.type="java.net.SocketTimeoutException"')).toBe(true);
    expect(matches('jsonPayload.error.type:socket')).toBe(true);
  });

  it('supports aliases', () => {
    expect(matches('service="payments-api"')).toBe(true);
    expect(matches('app_tla=PAY tla=PAY')).toBe(true);
    expect(matches('message:"calling deposit"')).toBe(true);
    expect(matches('status>=500')).toBe(true);
  });

  it('compares numbers and durations numerically', () => {
    expect(matches('httpRequest.status>=500')).toBe(true);
    expect(matches('httpRequest.status=504')).toBe(true);
    expect(matches('httpRequest.status<500')).toBe(false);
    expect(matches('httpRequest.status>=500', info)).toBe(false);
    expect(matches('httpRequest.latency>"1s"')).toBe(true);
    expect(matches('httpRequest.latency>2.5')).toBe(true);
    expect(matches('httpRequest.latency<"1s"', info)).toBe(true);
    expect(matches('jsonPayload.retries>2')).toBe(true);
  });

  it('compares timestamps by time', () => {
    expect(matches('timestamp>="2026-11-09T14:00:00Z"')).toBe(true);
    expect(matches('timestamp>="2026-11-09T09:30:00-05:00"')).toBe(true); // 14:30Z
    expect(matches('timestamp>"2026-11-09T09:30:00-05:00"')).toBe(false);
    expect(matches('timestamp<2026-11-09T15:00:00Z')).toBe(true);
    expect(matches('timestamp:"2026-11-09T14"')).toBe(true);
    expect(() => compileFilter('timestamp>=yesterday')).toThrow('Invalid timestamp');
  });

  it('supports regex operators', () => {
    expect(matches('jsonPayload.error.type=~"Socket\\w+Exception$"')).toBe(true);
    expect(matches('jsonPayload.error.type!~"^java"')).toBe(false);
    expect(matches('resource.labels.container_name=~"^ach-"')).toBe(false);
    expect(() => compileFilter('trace=~"(unclosed"')).toThrow('Invalid regular expression');
  });

  it('supports presence checks and missing fields', () => {
    expect(matches('trace:*')).toBe(true);
    expect(matches('trace:*', info)).toBe(false);
    expect(matches('jsonPayload.error:*', info)).toBe(false);
    expect(matches('jsonPayload.nope="x"')).toBe(false);
    expect(matches('jsonPayload.nope!="x"')).toBe(true);
    expect(matches('NOT jsonPayload.error:*', info)).toBe(true);
  });

  it('searches nested objects and arrays with :', () => {
    expect(matches('jsonPayload.error:"timed out"')).toBe(true);
    expect(matches('jsonPayload.tags:URGENT')).toBe(true);
    expect(matches('jsonPayload.tags=wire')).toBe(true);
  });

  it('runs global text search over payload, URL and labels', () => {
    expect(matches('timeout')).toBe(true);
    expect(matches('"read timed out"')).toBe(true); // nested error message
    expect(matches('/api/v1/payments')).toBe(true); // request URL
    expect(matches('payments-api')).toBe(true); // container name
    expect(matches('"Payments Hub"')).toBe(true); // labels
    expect(matches('nonexistentword')).toBe(false);
    expect(matches('PMT-1001', info)).toBe(true);
  });

  it('combines with AND, OR, NOT, minus and parentheses', () => {
    expect(matches('severity>=ERROR labels.app_tla=PAY')).toBe(true);
    expect(matches('severity>=ERROR AND labels.app_tla=ACH')).toBe(false);
    expect(matches('labels.app_tla=ACH OR labels.app_tla=PAY')).toBe(true);
    expect(matches('labels.app_tla=("ACH" OR "PAY")')).toBe(true);
    expect(matches('-labels.app_tla=PAY')).toBe(false);
    expect(matches('NOT (labels.app_tla=PAY AND severity=INFO)')).toBe(true);
    expect(matches('severity>=ERROR\nlabels.app_tla=ACH OR timeout')).toBe(true);
    expect(matches('severity>=ERROR\nlabels.app_tla=ACH OR timeout', info)).toBe(false);
    expect(matches('severity>=error and (tla=ACH or tla=PAY)')).toBe(true); // lowercase keywords
    expect(matches('tla=pay')).toBe(false); // = is exact
    expect(matches('tla:pay')).toBe(true); // : is case-insensitive
  });

  it('ignores comments', () => {
    expect(matches('severity>=ERROR -- only errors\nlabels.app_tla=PAY')).toBe(true);
  });

  it('matches textPayload entries', () => {
    const text = entry({ jsonPayload: undefined, textPayload: 'kernel: OOM killer invoked' });
    expect(matches('oom', text)).toBe(true);
    expect(matches('textPayload:"OOM killer"', text)).toBe(true);
    expect(matches('message:"OOM killer"', text)).toBe(true);
  });
});
