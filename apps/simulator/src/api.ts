import { badRequest, createApi, notFound, parseBody } from '@sim/api-kit';
import type { ScenarioDetail, ScenarioSummary, StopResponse } from '@sim/contracts/simulator';
import type { ScenarioDefinition } from '@sim/scenarios';
import { z } from 'zod';
import type { Engine } from './engine';
import { fanoutTargets } from './run';

export function scenarioSummary(s: ScenarioDefinition): ScenarioSummary {
  const impacted = new Set(s.impacts.map((i) => i.tla.toUpperCase()));
  for (const t of fanoutTargets(s)) impacted.add(t.app.tla);
  return {
    id: s.id,
    title: s.title,
    kind: s.kind,
    summary: s.summary,
    answer_key: {
      root_cause: s.answerKey.rootCause,
      culprit_tla: s.answerKey.culpritTla,
      affected_tlas: s.answerKey.affectedTlas,
      why_it_looks_green: s.answerKey.whyItLooksGreen,
    },
    culprit_project: s.badMr.project,
    fault_onset_sec: s.faultOnsetSec,
    impacted_tlas: [...impacted],
    alert_count: s.alerts.length,
    helpdesk_count: s.helpdesk?.length ?? 0,
    red_herring_count: s.redHerrings?.length ?? 0,
  };
}

export function scenarioDetail(s: ScenarioDefinition): ScenarioDetail {
  const fanout = fanoutTargets(s);
  return {
    ...scenarioSummary(s),
    bad_mr: {
      project: s.badMr.project,
      title: s.badMr.title,
      description: s.badMr.description,
      author: s.badMr.author,
      merged_by: s.badMr.mergedBy,
      source_branch: s.badMr.sourceBranch,
      labels: s.badMr.labels,
      edits: s.badMr.edits,
    },
    fix: {
      title: s.fix.title,
      description: s.fix.description,
      edits: s.fix.edits,
      files: s.fix.files,
    },
    impacts: s.impacts.map((i) => ({
      tla: i.tla,
      service: i.service ?? '',
      start_after_sec: i.startAfterSec,
      rate_per_sec: i.ratePerSec,
    })),
    fanout: (s.fanout ?? []).map((f, index) => ({
      upstream_tla: f.upstreamTla,
      start_after_sec: f.startAfterSec,
      rate_per_sec: f.ratePerSec,
      apps: fanout.filter((t) => t.fanoutIndex === index).map((t) => t.app.tla),
    })),
    alerts: s.alerts.map((a) => ({
      at_sec: a.atSec,
      severity: a.alert.severity,
      app_tla: a.alert.app_tla,
      description: a.alert.description,
      repeat_every_sec: a.repeatEverySec ?? null,
    })),
    helpdesk: (s.helpdesk ?? []).map((h) => ({
      at_sec: h.atSec,
      short_description: h.incident.short_description,
      caller: h.incident.caller ?? null,
    })),
    red_herrings: (s.redHerrings ?? []).map((h) => ({
      at_sec: h.atSec,
      kind: h.kind,
      project: h.project,
      title: h.title,
    })),
  };
}

const triggerSchema = z
  .object({
    speed: z.number().min(0.1).max(100).optional(),
    force: z.boolean().optional(),
  })
  .default({});

const trafficSchema = z.object({
  paused: z.boolean().optional(),
  rate_multiplier: z.number().min(0).max(10).optional(),
});

export function createSimulatorApi(engine: Engine) {
  const app = createApi({
    service: 'simulator',
    stats: () => {
      const s = engine.status();
      return {
        lines_per_sec: s.traffic.lines_per_sec,
        total_lines: s.traffic.total_lines,
        scenarios: engine.scenarios.length,
        active_runs: s.run?.active ? 1 : 0,
      };
    },
  });

  app.get('/api/scenarios', (c) => c.json(engine.scenarios.map(scenarioSummary)));

  app.get('/api/scenarios/:id', (c) => {
    const s = engine.scenarios.find((x) => x.id === c.req.param('id'));
    if (!s) throw notFound(`Unknown scenario: ${c.req.param('id')}`);
    return c.json(scenarioDetail(s));
  });

  app.post('/api/scenarios/:id/trigger', async (c) => {
    const text = await c.req.text();
    let raw: unknown = {};
    if (text.trim()) {
      try {
        raw = JSON.parse(text);
      } catch {
        throw badRequest('Request body must be JSON');
      }
    }
    const body = triggerSchema.parse(raw);
    const run = await engine.trigger(c.req.param('id'), body);
    return c.json(run, 201);
  });

  app.post('/api/stop', (c) => c.json<StopResponse>({ run: engine.stop() }));

  app.post('/api/reset', async (c) => c.json(await engine.reset()));

  app.get('/api/status', (c) => c.json(engine.status()));

  app.post('/api/traffic', async (c) => {
    const body = await parseBody(c, trafficSchema);
    return c.json(engine.setTraffic(body));
  });

  return app;
}
