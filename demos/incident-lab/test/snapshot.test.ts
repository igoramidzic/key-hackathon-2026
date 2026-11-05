import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../simulation';

test('durable snapshot preserves stage progress, IDs and deterministic generation across restarts', () => {
  const now = () => Date.parse('2026-11-05T18:00:00Z');
  const original = new Simulation({ now });
  original.inject({ scenario: 'bad-deploy', appId: 'payments-worker' });
  original.tick(10);
  const snapshot = original.snapshot();
  const restored = new Simulation({ now });
  restored.restore(snapshot);
  original.tick(12);
  restored.tick(12);
  assert.deepEqual(restored.state(), original.state());
  restored.sendMessage('Show evidence');
  restored.resolve();
  restored.inject({ scenario: 'latency', appId: 'checkout-api' });
  restored.tick(22);
  assert.equal(new Set(restored.incidents.map((i) => i.id)).size, 2);
  assert.equal(restored.incidents[0].appId, 'checkout-api');
  assert.equal(snapshot.state.simulation.phase, 'enriching');
});
