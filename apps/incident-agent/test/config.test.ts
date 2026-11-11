import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

describe('incident agent config', () => {
  it('loads default local URLs and threshold defaults', () => {
    const config = loadConfig({});

    expect(config.urls.mcp.logs).toBe('http://localhost:5001/mcp');
    expect(config.urls.mcp.servicenow).toBe('http://localhost:5002/mcp');
    expect(config.urls.mcp.gitlab).toBe('http://localhost:5003/mcp');
    expect(config.urls.mcp.teams).toBe('http://localhost:5004/mcp');
    expect(config.urls.streams.logs).toBe('http://localhost:4001/api/logs/stream');
    expect(config.urls.streams.activity).toBe('http://localhost:4002/api/activity/stream');

    expect(config.dryRun).toBe(false);
    expect(config.autoResolve).toBe(false);
    expect(config.thresholds.errorThreshold).toBe(5);
    expect(config.thresholds.windowSeconds).toBe(60);
    expect(config.thresholds.warningThreshold).toBe(20);
    expect(config.models.anthropic).toBe('claude-3-7-sonnet-20250219');
    expect(config.models.gemini).toBe('gemini-2.5-flash');
    expect(config.models.agent).toBe('claude-3-7-sonnet-20250219');
  });

  it('honors SIM_PUBLIC_URL and prefixes endpoints', () => {
    const config = loadConfig({
      SIM_PUBLIC_URL: 'https://hackathon-incident-lab.kualia.workers.dev/',
    });

    const expectedBase = 'https://hackathon-incident-lab.kualia.workers.dev';
    expect(config.simPublicUrl).toBe(expectedBase);
    expect(config.urls.mcp.logs).toBe(`${expectedBase}/logs/mcp`);
    expect(config.urls.mcp.servicenow).toBe(`${expectedBase}/servicenow/mcp`);
    expect(config.urls.mcp.gitlab).toBe(`${expectedBase}/gitlab/mcp`);
    expect(config.urls.mcp.teams).toBe(`${expectedBase}/teams/mcp`);
    expect(config.urls.streams.logs).toBe(`${expectedBase}/logs/api/logs/stream`);
    expect(config.urls.streams.activity).toBe(`${expectedBase}/servicenow/api/activity/stream`);
  });

  it('allows individual URL overrides', () => {
    const config = loadConfig({
      LOGS_MCP_URL: 'http://custom-host:9001/mcp',
      ACTIVITY_STREAM_URL: 'http://custom-host:9002/activity',
    });

    expect(config.urls.mcp.logs).toBe('http://custom-host:9001/mcp');
    expect(config.urls.streams.activity).toBe('http://custom-host:9002/activity');
    // Defaults for the rest
    expect(config.urls.mcp.servicenow).toBe('http://localhost:5002/mcp');
  });

  it('parses boolean flags from string inputs', () => {
    const configTrue = loadConfig({
      AGENT_DRY_RUN: 'true',
      AGENT_AUTO_RESOLVE: '1',
    });
    expect(configTrue.dryRun).toBe(true);
    expect(configTrue.autoResolve).toBe(true);

    const configFalse = loadConfig({
      AGENT_DRY_RUN: 'false',
      AGENT_AUTO_RESOLVE: '0',
    });
    expect(configFalse.dryRun).toBe(false);
    expect(configFalse.autoResolve).toBe(false);
  });

  it('parses custom detection thresholds', () => {
    const config = loadConfig({
      DETECTION_ERROR_THRESHOLD: '10',
      DETECTION_WINDOW_SECONDS: '120',
      DETECTION_WARNING_THRESHOLD: '50',
    });

    expect(config.thresholds.errorThreshold).toBe(10);
    expect(config.thresholds.windowSeconds).toBe(120);
    expect(config.thresholds.warningThreshold).toBe(50);
  });

  it('parses API keys and custom model ID', () => {
    const config = loadConfig({
      ANTHROPIC_API_KEY: 'sk-ant-test',
      GEMINI_API_KEY: 'test-gemini-key',
      AGENT_MODEL: 'gemini-2.5-pro',
    });

    expect(config.keys.anthropic).toBe('sk-ant-test');
    expect(config.keys.gemini).toBe('test-gemini-key');
    expect(config.models.agent).toBe('gemini-2.5-pro');
  });

  it('throws a formatted ConfigError on invalid URL', () => {
    expect(() =>
      loadConfig({
        SIM_PUBLIC_URL: 'not-a-valid-url',
      }),
    ).toThrowError(ConfigError);

    try {
      loadConfig({ SIM_PUBLIC_URL: 'not-a-valid-url' });
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ConfigError);
      const configErr = err as ConfigError;
      expect(configErr.message).toContain('Invalid incident agent configuration');
      expect(configErr.message).toContain('SIM_PUBLIC_URL: Must be a valid URL string');
    }
  });

  it('throws a formatted ConfigError on invalid threshold number', () => {
    expect(() =>
      loadConfig({
        DETECTION_ERROR_THRESHOLD: '-5',
      }),
    ).toThrowError(ConfigError);

    try {
      loadConfig({ DETECTION_ERROR_THRESHOLD: 'invalid-num' });
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ConfigError);
      const configErr = err as ConfigError;
      expect(configErr.message).toContain('DETECTION_ERROR_THRESHOLD: Must be a positive number');
    }
  });
});
