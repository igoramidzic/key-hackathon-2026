import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('defaults to the local multi-port world', () => {
    const c = loadConfig({});
    expect(c.hosted).toBe(false);
    expect(c.mcp.logs).toBe('http://localhost:5001/mcp');
    expect(c.mcp.teams).toBe('http://localhost:5004/mcp');
    expect(c.logsApi).toBe('http://localhost:4001');
    expect(c.serviceNowApi).toBe('http://localhost:4002');
    expect(c.dryRun).toBe(false);
    expect(c.autoResolve).toBe(false);
    expect(c.llm.mode).toBe('off');
    expect(c.llm.model).toBe('claude-sonnet-5-5');
    expect(c.llm.deepModel).toBe('claude-opus-5-5');
  });

  it('uses path prefixes on the hosted worker', () => {
    const c = loadConfig({ SIM_PUBLIC_URL: 'https://lab.example.dev/' });
    expect(c.hosted).toBe(true);
    expect(c.mcp.gitlab).toBe('https://lab.example.dev/gitlab/mcp');
    expect(c.logsApi).toBe('https://lab.example.dev/logs');
    expect(c.serviceNowApi).toBe('https://lab.example.dev/servicenow');
  });

  it('turns Claude on in auto mode when credentials exist', () => {
    expect(loadConfig({ ANTHROPIC_API_KEY: 'sk-test' }).llm.mode).toBe('claude');
    expect(loadConfig({ ANTHROPIC_API_KEY: 'sk-test', AGENT_LLM: 'off' }).llm.mode).toBe('off');
  });

  it('parses booleans and scales windows by speed', () => {
    const c = loadConfig({ AGENT_DRY_RUN: 'yes', AGENT_SPEED: '4', AGENT_SETTLE_SEC: '40' });
    expect(c.dryRun).toBe(true);
    expect(c.correlate.settleSec).toBe(10);
  });

  it('fails with a clear message on bad values', () => {
    expect(() => loadConfig({ AGENT_DRY_RUN: 'maybe', AGENT_SPEED: 'fast' })).toThrow(ConfigError);
    try {
      loadConfig({ AGENT_DRY_RUN: 'maybe' });
    } catch (err) {
      expect((err as Error).message).toContain('AGENT_DRY_RUN');
    }
  });
});
