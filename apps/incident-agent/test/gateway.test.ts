import { describe, expect, it } from 'vitest';
import {
  type ClientFactory,
  isTransient,
  McpGateway,
  McpToolError,
  type ToolCallRecord,
  type ToolClient,
} from '../src/mcp/gateway';

const URLS = {
  logs: 'http://logs/mcp',
  servicenow: 'http://sn/mcp',
  gitlab: 'http://gl/mcp',
  teams: 'http://teams/mcp',
};

function fakeFactory(
  handler: (tool: string, args: Record<string, unknown>) => unknown,
  counters = { connects: 0, calls: 0 },
): ClientFactory {
  return async () => {
    counters.connects++;
    const client: ToolClient = {
      async callTool(name, args) {
        counters.calls++;
        const out = handler(name, args);
        if (out instanceof Error) throw out;
        if (out && typeof out === 'object' && 'isError' in out) return out as never;
        return { content: [{ type: 'text', text: JSON.stringify(out) }] };
      },
      listTools: async () => ['a'],
      close: async () => {},
    };
    return client;
  };
}

describe('McpGateway', () => {
  it('parses JSON results and reports the call', async () => {
    const records: ToolCallRecord[] = [];
    const gw = new McpGateway({
      urls: URLS,
      factory: fakeFactory(() => ({ items: [1, 2] })),
      onCall: (r) => records.push(r),
    });
    const out = await gw.call<{ items: number[] }>(
      'search_logs',
      { app_tla: 'PAY' },
      { caseId: 'c1' },
    );
    expect(out.items).toEqual([1, 2]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      server: 'logs',
      tool: 'search_logs',
      ok: true,
      caseId: 'c1',
    });
    expect(records[0]!.args).toContain('PAY');
  });

  it('retries connection errors and 5xx with a fresh client', async () => {
    const counters = { connects: 0, calls: 0 };
    let n = 0;
    const gw = new McpGateway({
      urls: URLS,
      sleep: async () => {},
      factory: fakeFactory(() => {
        n++;
        if (n === 1)
          return Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
        if (n === 2)
          return Object.assign(new Error('Error POSTing to endpoint (HTTP 503)'), { code: 503 });
        return { ok: true };
      }, counters),
    });
    await expect(gw.call('get_app', { tla: 'PAY' })).resolves.toEqual({ ok: true });
    expect(counters.calls).toBe(3);
    expect(counters.connects).toBe(3);
  });

  it('gives up after the retry budget', async () => {
    const records: ToolCallRecord[] = [];
    const gw = new McpGateway({
      urls: URLS,
      sleep: async () => {},
      onCall: (r) => records.push(r),
      factory: fakeFactory(() => new TypeError('fetch failed')),
    });
    await expect(gw.call('get_app', { tla: 'PAY' }, { retries: 2 })).rejects.toThrow(
      'fetch failed',
    );
    expect(records[0]).toMatchObject({ ok: false, attempts: 3 });
  });

  it('surfaces tool errors without retrying', async () => {
    const counters = { connects: 0, calls: 0 };
    const gw = new McpGateway({
      urls: URLS,
      factory: fakeFactory(
        () => ({
          isError: true,
          content: [{ type: 'text', text: 'Unknown user "dwhitfeld". Did you mean dwhitfield?' }],
        }),
        counters,
      ),
    });
    const err = await gw.call('add_channel_members', { channel: 'x', members: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).text).toContain('Did you mean dwhitfield');
    expect((err as McpToolError).notFound).toBe(true);
    expect(counters.calls).toBe(1);
  });

  it('logs writes instead of calling them in dry-run mode', async () => {
    const counters = { connects: 0, calls: 0 };
    const dry: string[] = [];
    const gw = new McpGateway({
      urls: URLS,
      dryRun: true,
      onDryRun: (tool) => dry.push(tool),
      factory: fakeFactory(() => ({ read: true }), counters),
    });
    const created = await gw.call<{ dry_run: boolean; number: string }>('create_incident', {
      short_description: 'x',
    });
    expect(created.dry_run).toBe(true);
    expect(created.number).toMatch(/^INCDRY/);
    expect(dry).toEqual(['create_incident']);
    expect(counters.calls).toBe(0);
    // Reads still go through.
    await expect(gw.call('get_incident', { number: 'INC1' })).resolves.toEqual({ read: true });
    expect(counters.calls).toBe(1);
  });

  it('rejects unknown tools', async () => {
    const gw = new McpGateway({ urls: URLS, factory: fakeFactory(() => ({})) });
    await expect(gw.call('drop_database', {})).rejects.toThrow('Unknown MCP tool');
  });
});

describe('isTransient', () => {
  it('classifies errors', () => {
    expect(isTransient(new TypeError('fetch failed'))).toBe(true);
    expect(isTransient(Object.assign(new Error('x'), { code: 502 }))).toBe(true);
    expect(isTransient(Object.assign(new Error('x'), { code: 404 }))).toBe(false);
    expect(isTransient(new McpToolError('logs', 'get_alert', 'timed out'))).toBe(false);
  });
});
