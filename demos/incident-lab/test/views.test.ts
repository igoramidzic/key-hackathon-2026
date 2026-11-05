import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../simulation';
import { renderService } from '../public/views/services';
import { renderTeams } from '../public/views/teams';

test('linked provider views expose the selected incident evidence and scenario-specific change', () => {
  const sim = new Simulation();
  sim.inject({ scenario: 'bad-deploy', appId: 'payments-worker' });
  sim.tick(22);
  const state = sim.state();
  const log = state.logs.find((entry) => entry.source === 'gcp' && entry.severity === 'ERROR')!;
  const query = new URLSearchParams({ app: 'payments-worker', log: log.id });
  const logs = renderService('gcp', state, query);
  assert.match(logs, /is-selected/);
  assert.ok(logs.includes(log.traceId));
  const change = renderService(
    'servicenow',
    state,
    new URLSearchParams({ app: 'payments-worker', record: 'CHG0031842' }),
  );
  assert.match(change, /settlement currency/);
  assert.match(change, /Payments Engineering/);
  assert.match(renderService('confluence', state, query), /Deployment regression/);
  sim.resolve();
  assert.match(renderService('moogsoft', sim.state(), query), /Resolved/);
});

test('chat only claims a created room when collaboration begins and resets on replay', () => {
  const sim = new Simulation();
  sim.inject();
  assert.match(renderTeams(sim.state()), /Waiting for the incident chat/);
  sim.tick(5);
  const pending = renderTeams(sim.state());
  assert.match(pending, /Waiting for the incident chat/);
  assert.doesNotMatch(pending, /teams-message-input/);
  sim.tick(17);
  const room = renderTeams(sim.state());
  assert.match(room, /teams-message-input/);
  assert.match(room, /· checkout-api/);
  sim.resolve();
  assert.match(renderTeams(sim.state()), /Incident resolved/);
  sim.inject({ appId: 'payments-api' });
  assert.doesNotMatch(renderTeams(sim.state()), /· checkout-api/);
});

test('provider and chat renderers escape untrusted log and message content', () => {
  const sim = new Simulation();
  sim.inject();
  sim.tick(22);
  const hostile = '<img src=x onerror="alert(1)">';
  sim.logs[0].message = hostile;
  const provider = renderService(sim.logs[0].source, sim.state());
  assert.doesNotMatch(provider, /<img src=x/);
  assert.ok(provider.includes('&lt;img'));
  sim.messages[1].text = hostile;
  sim.messages[1].links = [{ label: 'Untrusted', href: 'javascript:alert(1)' }];
  const chat = renderTeams(sim.state());
  assert.doesNotMatch(chat, /<img src=x/);
  assert.doesNotMatch(chat, /href="javascript:/);
  assert.ok(chat.includes('&lt;img'));
});
