import { describe, expect, it } from 'vitest';
import { buildWorld } from './generate';
import { getWorld, HERO_TLAS, incidentChannelName, PAST_MAJOR_INCIDENTS } from './index';

describe('world', () => {
  it('is deterministic', () => {
    const a = buildWorld();
    const b = buildWorld();
    expect(a.people.map((p) => p.username)).toEqual(b.people.map((p) => p.username));
    expect(a.apps.map((x) => [x.tla, x.name, x.upstream])).toEqual(
      b.apps.map((x) => [x.tla, x.name, x.upstream]),
    );
    expect(a.repos.map((r) => r.path)).toEqual(b.repos.map((r) => r.path));
  });

  it('has unique keys and consistent references', () => {
    const w = getWorld();
    expect(new Set(w.apps.map((a) => a.tla)).size).toBe(w.apps.length);
    expect(new Set(w.people.map((p) => p.username)).size).toBe(w.people.length);
    expect(new Set(w.people.map((p) => p.email)).size).toBe(w.people.length);
    expect(new Set(w.repos.map((r) => r.path)).size).toBe(w.repos.length);
    for (const app of w.apps) {
      expect(app.tla).toMatch(/^[A-Z]{3}$/);
      expect(w.groupsById.has(app.supportGroupId)).toBe(true);
      expect(w.peopleByUsername.has(app.ownerUsername)).toBe(true);
      for (const up of app.upstream) expect(w.appsByTla.has(up)).toBe(true);
      for (const path of app.repoPaths) expect(path.startsWith(`keybank/${app.tla}00/`)).toBe(true);
    }
    for (const group of w.groups) {
      expect(group.memberUsernames.length).toBeGreaterThan(0);
      for (const u of group.memberUsernames) expect(w.peopleByUsername.has(u)).toBe(true);
    }
    for (const tla of HERO_TLAS) expect(w.appsByTla.get(tla)?.hero).toBe(true);
  });

  it('is big enough to feel real', () => {
    const w = getWorld();
    expect(w.apps.length).toBeGreaterThanOrEqual(400);
    expect(w.people.length).toBeGreaterThanOrEqual(1000);
    expect(w.repos.length).toBeGreaterThanOrEqual(700);
    expect(w.apps.filter((a) => a.emitsLogs).length).toBe(60);
  });

  it('has valid past major incidents', () => {
    const w = getWorld();
    // Standard ServiceNow priority matrix: impact + urgency - 1.
    const priorityOf = (impact: number, urgency: number) => `P${impact + urgency - 1}`;
    expect(new Set(PAST_MAJOR_INCIDENTS.map((i) => i.number)).size).toBe(
      PAST_MAJOR_INCIDENTS.length,
    );
    for (const inc of PAST_MAJOR_INCIDENTS) {
      expect(inc.number).toMatch(/^INC\d{7}$/);
      expect(w.appsByTla.get(inc.tla)?.hero).toBe(true);
      if (inc.extraTla) expect(w.appsByTla.has(inc.extraTla)).toBe(true);
      expect(priorityOf(inc.impact, inc.urgency)).toBe(inc.priority);
      expect(incidentChannelName(inc)).toMatch(/^[a-z0-9-]{1,50}$/);
      expect(inc.hoursAgo * 60).toBeGreaterThan(inc.durationMin);
    }
  });
});
