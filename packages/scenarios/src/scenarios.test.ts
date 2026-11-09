import type { FileEdit } from '@sim/contracts/gitlab';
import { SEVERITIES } from '@sim/contracts/logs';
import { type App, dependencyClosure, getApp, getWorld, HERO_TLAS, Rng } from '@sim/world';
import { describe, expect, it } from 'vitest';
import { getScenario, heroRepoOverlays, scenarios } from './index';
import { ABA_PATHS } from './repos/aba';
import { ATH_PATHS } from './repos/ath';
import { CIF_PATHS } from './repos/cif';
import { CRD_PATHS } from './repos/crd';
import { TLR_PATHS } from './repos/tlr';
import type { LogContext, LogTemplate, ScenarioDefinition } from './types';

type Files = Record<string, string | null>;

/** Same semantics as the GitLab API: `content` writes the file, find must occur exactly once. */
function applyEdits(files: Files, edits: FileEdit[]): Files {
  const out = { ...files };
  for (const edit of edits) {
    if (edit.content !== undefined) {
      out[edit.path] = edit.content;
      continue;
    }
    const current = out[edit.path];
    if (current == null) throw new Error(`${edit.path}: file does not exist`);
    if (edit.find === undefined) throw new Error(`${edit.path}: edit has neither content nor find`);
    const count = current.split(edit.find).length - 1;
    if (count !== 1) throw new Error(`${edit.path}: find occurs ${count} times`);
    out[edit.path] = current.replace(edit.find, () => edit.replace ?? '');
  }
  return out;
}

function overlayFiles(project: string): Files {
  return { ...(heroRepoOverlays[project]?.files ?? {}) };
}

/** What `git revert` of the bad MR leaves: overlay content, files the MR created are gone. */
function reverted(s: ScenarioDefinition): Files {
  const files = overlayFiles(s.badMr.project);
  for (const edit of s.badMr.edits) if (!(edit.path in files)) files[edit.path] = null;
  return files;
}

const afterBad = (s: ScenarioDefinition) =>
  applyEdits(overlayFiles(s.badMr.project), s.badMr.edits);
const afterFix = (s: ScenarioDefinition) => applyEdits(afterBad(s), s.fix.edits);

function scenario(id: string): ScenarioDefinition {
  const s = getScenario(id);
  if (!s) throw new Error(`missing scenario ${id}`);
  return s;
}

function stubContext(app: App, seed: string): LogContext {
  const rng = new Rng(seed);
  return {
    rng,
    app,
    service: app.runtime.service,
    now: new Date('2026-11-09T19:42:13.512Z'),
    elapsedSec: rng.int(0, 120),
    traceId: () => rng.hex(32),
    account: () => `****${rng.int(1000, 9999)}`,
    customerId: () => `C${rng.int(10_000_000, 99_999_999)}`,
    requestId: () => `${rng.hex(8)}-${rng.hex(4)}-${rng.hex(4)}`,
    routingNumber: () => rng.pick(['041001039', '021000021', '011000015', '044000037']),
    amount: () => `${rng.int(1, 9)},${rng.int(100, 999)}.${rng.int(10, 99)}`,
  };
}

function overlayForApp(tla: string): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const path of getApp(tla).repoPaths) Object.assign(merged, heroRepoOverlays[path]?.files);
  return merged;
}

/** Every app frame in a stack trace must point at an existing, non-blank line of an overlay file. */
function checkFrames(stack: string, files: Record<string, string>, where: string) {
  const lineAt = (path: string, line: number) => {
    const content = files[path];
    expect(
      content,
      `${where}: ${path} is referenced by a stack frame but not in the overlay`,
    ).toBeDefined();
    const text = content!.split('\n')[line - 1];
    expect(text?.trim(), `${where}: ${path}:${line} is blank or out of range`).toBeTruthy();
    return text!;
  };
  for (const m of stack.matchAll(/\tat (com\.keybank\.[\w.]+)\.[\w$<>]+\((\w+)\.java:(\d+)\)/g)) {
    lineAt(`src/main/java/${m[1]!.replace(/\./g, '/')}.java`, Number(m[3]));
  }
  for (const m of stack.matchAll(/\(\/app\/(src\/[\w/.-]+\.ts):(\d+):(\d+)\)/g)) {
    const text = lineAt(m[1]!, Number(m[2]));
    expect(Number(m[3])).toBeLessThanOrEqual(text.length);
  }
  for (const m of stack.matchAll(
    /File "\/app\/(src\/[\w/.-]+\.py)", line (\d+), in \w+\n {4}(.*)/g,
  )) {
    expect(lineAt(m[1]!, Number(m[2])).trim()).toBe(m[3]);
  }
}

function renderAll(templates: LogTemplate[], app: App, key: string, checkStacks: boolean) {
  const files = checkStacks ? overlayForApp(app.tla) : {};
  templates.forEach((t, i) => {
    for (let n = 0; n < 15; n++) {
      const out = t.render(stubContext(app, `${key}:${i}:${n}`));
      expect(SEVERITIES).toContain(t.severity);
      expect(out.message.length, key).toBeGreaterThan(10);
      expect(() => JSON.stringify(out)).not.toThrow();
      if (out.httpRequest) {
        expect(out.httpRequest.requestUrl).toMatch(/^https:\/\//);
        expect(out.httpRequest.status).toBeGreaterThanOrEqual(100);
        expect(out.httpRequest.latencySec).toBeGreaterThanOrEqual(0);
      }
      if (out.error?.stack_trace && checkStacks) checkFrames(out.error.stack_trace, files, key);
    }
  });
}

const people = getWorld().peopleByUsername;

describe('scenario catalog', () => {
  it('has the five scenarios with unique ids', () => {
    expect(scenarios.map((s) => s.id)).toEqual([
      'cif-snake-case-cascade',
      'ath-token-ttl-cascade',
      'aba-checksum-cascade',
      'crd-pool-exhaustion',
      'tlr-business-date-helpdesk',
    ]);
  });

  it('only overlays hero repos that exist, culprits are complete codebases', () => {
    const repos = getWorld().reposByPath;
    for (const [path, overlay] of Object.entries(heroRepoOverlays)) {
      const repo = repos.get(path);
      expect(repo, path).toBeDefined();
      expect(HERO_TLAS).toContain(repo!.tla);
      expect(Object.keys(overlay.files).length).toBeGreaterThan(0);
    }
    for (const s of scenarios) {
      expect(heroRepoOverlays[s.badMr.project]?.complete, s.id).toBe(true);
      expect(s.badMr.project.split('/')[1]).toBe(`${s.answerKey.culpritTla}00`);
    }
  });

  it('keeps Java overlay paths in their package directories', () => {
    for (const [path, overlay] of Object.entries(heroRepoOverlays)) {
      const tla = path.split('/')[1]!.slice(0, 3).toLowerCase();
      for (const [file, content] of Object.entries(overlay.files)) {
        if (!file.endsWith('.java')) continue;
        expect(file).toMatch(new RegExp(`^src/(main|test)/java/com/keybank/${tla}/`));
        const pkg = file.replace(/^src\/(main|test)\/java\//, '').replace(/\/[^/]+\.java$/, '');
        expect(content.startsWith(`package ${pkg.replace(/\//g, '.')};`), file).toBe(true);
      }
    }
  });
});

describe.each(scenarios.map((s) => [s.id, s] as const))('%s', (_id, s) => {
  it('bad MR applies to the overlay, the fix applies on top', () => {
    expect(() => afterBad(s)).not.toThrow();
    expect(() => afterFix(s)).not.toThrow();
    expect(new Set(s.badMr.edits.map((e) => e.path)).size).toBe(s.badMr.edits.length);
    expect(new Set(s.fix.edits.map((e) => e.path)).size).toBe(s.fix.edits.length);
  });

  it('isFixed: false after the bad MR, true after the fix and after a revert', () => {
    const pick = (files: Files) =>
      Object.fromEntries(s.fix.files.map((f) => [f, files[f] ?? null])) as Files;
    expect(s.fix.isFixed(pick(afterBad(s)))).toBe(false);
    expect(s.fix.isFixed(pick(afterFix(s)))).toBe(true);
    expect(s.fix.isFixed(pick(reverted(s)))).toBe(true);
  });

  it('replace strings are safe for naive String.replace', () => {
    const edits = [
      ...s.badMr.edits,
      ...s.fix.edits,
      ...(s.redHerrings ?? []).flatMap((r) => r.edits),
    ];
    for (const edit of edits) {
      if (edit.replace !== undefined) expect(edit.replace).not.toMatch(/\$[$&'`\d]/);
    }
  });

  it('impacted apps exist and sit downstream of the culprit', () => {
    const culprit = s.answerKey.culpritTla;
    const downstream = new Set(dependencyClosure(culprit, 'down').map((d) => d.tla));
    for (const impact of s.impacts) {
      expect(() => getApp(impact.tla)).not.toThrow();
      if (impact.tla === culprit) {
        expect(['single-app', 'helpdesk']).toContain(s.kind);
      } else if (s.kind !== 'cascade' && getApp(culprit).upstream.includes(impact.tla)) {
        // A callee receiving bad data from the culprit (TLR posting future dates to GLD).
        expect(impact.templates.every((t) => t.severity === 'WARNING')).toBe(true);
      } else {
        expect(downstream.has(impact.tla), `${impact.tla} downstream of ${culprit}`).toBe(true);
      }
    }
    for (const f of s.fanout ?? []) {
      expect(f.upstreamTla === culprit || downstream.has(f.upstreamTla)).toBe(true);
    }
    const impacted = new Set(s.impacts.map((i) => i.tla));
    for (const tla of s.answerKey.affectedTlas) expect(impacted.has(tla), tla).toBe(true);
  });

  it('people and groups exist in the world', () => {
    const usernames = [
      s.badMr.author,
      s.badMr.mergedBy,
      ...(s.badMr.approvers ?? []),
      ...(s.redHerrings ?? []).flatMap((r) => [r.author, ...(r.mergedBy ? [r.mergedBy] : [])]),
      ...(s.helpdesk ?? []).flatMap((h) =>
        [h.incident.caller, h.incident.opened_by, h.incident.assigned_to].filter(
          (u): u is string => u !== undefined,
        ),
      ),
    ];
    for (const u of usernames) expect(people.has(u), u).toBe(true);
    const groups = getWorld().groups;
    for (const h of s.helpdesk ?? []) {
      const g = h.incident.assignment_group;
      if (g)
        expect(
          groups.some((x) => x.id === g || x.name === g),
          g,
        ).toBe(true);
    }
  });

  it('every log template renders, stack frames point at overlay code', () => {
    const culprit = getApp(s.answerKey.culpritTla);
    if (s.culpritSignals) renderAll(s.culpritSignals.templates, culprit, `${s.id}:culprit`, true);
    for (const impact of s.impacts) {
      expect(impact.templates.length).toBeGreaterThan(0);
      renderAll(impact.templates, getApp(impact.tla), `${s.id}:${impact.tla}`, true);
    }
    for (const f of s.fanout ?? []) {
      const listed = new Set(s.impacts.map((i) => i.tla));
      const apps = getApp(f.upstreamTla)
        .downstream.map((t) => getApp(t))
        .filter((a) => a.emitsLogs && !listed.has(a.tla));
      expect(apps.length).toBeGreaterThan(0);
      for (const app of apps) {
        const templates = f.templates(app, app.stack);
        if (['java-spring', 'node-ts', 'python'].includes(app.stack)) {
          expect(templates.length).toBeGreaterThan(0);
        }
        renderAll(templates, app, `${s.id}:fanout:${app.tla}`, false);
      }
    }
  });

  it('red herrings are valid changes that keep stack-trace line numbers stable', () => {
    for (const r of s.redHerrings ?? []) {
      expect(getWorld().reposByPath.has(r.project), r.project).toBe(true);
      const overlay = heroRepoOverlays[r.project];
      if (overlay) {
        expect(() => applyEdits(overlayFiles(r.project), r.edits)).not.toThrow();
      } else {
        // Template content is unknown: only new files with full content.
        for (const e of r.edits) expect(e.content, `${r.project}:${e.path}`).toBeDefined();
      }
      for (const e of r.edits) {
        if (e.content !== undefined && overlay) {
          expect(
            overlay.files[e.path],
            `${r.project}:${e.path} overwrites overlay`,
          ).toBeUndefined();
        }
        if (e.find !== undefined) {
          expect(e.find.split('\n').length).toBe((e.replace ?? '').split('\n').length);
        }
      }
    }
  });

  it('timing and volume are sane', () => {
    expect(s.faultOnsetSec).toBeGreaterThanOrEqual(15);
    expect(s.faultOnsetSec).toBeLessThanOrEqual(45);
    for (const impact of s.impacts) expect(impact.startAfterSec).toBeLessThanOrEqual(60);
    const fanoutRate = (s.fanout ?? []).reduce((sum, f) => {
      const listed = new Set(s.impacts.map((i) => i.tla));
      const n = getApp(f.upstreamTla).downstream.filter(
        (t) => getApp(t).emitsLogs && !listed.has(t),
      ).length;
      return sum + n * f.ratePerSec;
    }, 0);
    const errorRate = s.impacts.reduce((sum, i) => sum + i.ratePerSec, 0) + fanoutRate;
    expect(errorRate).toBeLessThanOrEqual(40);
    if (s.kind === 'helpdesk') {
      expect(s.helpdesk?.length).toBeGreaterThan(0);
      for (const h of s.helpdesk ?? []) expect(h.incident.app_tla).toBeUndefined();
    } else {
      const first = Math.min(...s.alerts.map((a) => a.atSec));
      expect(first).toBeGreaterThanOrEqual(45);
      expect(first).toBeLessThanOrEqual(90);
    }
    if (s.kind === 'cascade') {
      // The culprit looks green: no alerts, no ERROR lines of its own.
      expect(s.alerts.some((a) => a.alert.app_tla === s.answerKey.culpritTla)).toBe(false);
      for (const t of s.culpritSignals?.templates ?? [])
        expect(['INFO', 'NOTICE', 'WARNING']).toContain(t.severity);
    }
    const keys = s.alerts.map((a) => a.alert.dedupe_key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('fix predicates accept reasonable alternative fixes', () => {
  const run = (id: string, mutate: (files: Files) => Files) => {
    const s = scenario(id);
    const files = mutate(afterBad(s));
    return s.fix.isFixed(Object.fromEntries(s.fix.files.map((f) => [f, files[f] ?? null])));
  };
  const edit = (path: string, find: string | RegExp, replace: string) => (files: Files) => ({
    ...files,
    [path]: (files[path] ?? '').replace(find, replace),
  });

  it('cif-snake-case-cascade', () => {
    const id = 'cif-snake-case-cascade';
    const yml = CIF_PATHS.applicationYml;
    expect(run(id, edit(yml, /\n {4}property-naming-strategy: SNAKE_CASE/, ''))).toBe(true);
    expect(run(id, edit(yml, 'SNAKE_CASE', '"LOWER_CAMEL_CASE"'))).toBe(true);
    expect(run(id, edit(yml, 'SNAKE_CASE', 'KEBAB_CASE'))).toBe(false);
    expect(
      run(
        id,
        edit(
          yml,
          'property-naming-strategy: SNAKE_CASE',
          'property-naming-strategy: SNAKE_CASE # TODO',
        ),
      ),
    ).toBe(false);
    expect(
      run(
        id,
        edit(
          CIF_PATHS.profileDto,
          'public record CustomerProfileResponse(',
          '@JsonNaming(PropertyNamingStrategies.LowerCamelCaseStrategy.class)\npublic record CustomerProfileResponse(',
        ),
      ),
    ).toBe(true);
  });

  it('ath-token-ttl-cascade', () => {
    const id = 'ath-token-ttl-cascade';
    expect(
      run(
        id,
        edit(
          ATH_PATHS.config,
          'accessTokenTtl: file.tokens.access_token_ttl,',
          'accessTokenTtl: file.tokens.access_token_ttl * 60,',
        ),
      ),
    ).toBe(true);
    expect(
      run(
        id,
        edit(
          ATH_PATHS.tokenService,
          'config.tokens.accessTokenTtl;',
          '60 * config.tokens.accessTokenTtl;',
        ),
      ),
    ).toBe(true);
    expect(run(id, edit(ATH_PATHS.tokenService, 'config.tokens.accessTokenTtl;', '900;'))).toBe(
      true,
    );
    expect(
      run(id, edit(ATH_PATHS.configYaml, 'access_token_ttl: 15', 'access_token_ttl: 900')),
    ).toBe(true);
    // Converting twice gives 15 hours: still wrong.
    expect(
      run(id, (f) =>
        edit(
          ATH_PATHS.tokenService,
          'config.tokens.accessTokenTtl;',
          'config.tokens.accessTokenTtl * 60;',
        )(
          edit(
            ATH_PATHS.config,
            'file.tokens.access_token_ttl,',
            'file.tokens.access_token_ttl * 60,',
          )(f),
        ),
      ),
    ).toBe(false);
    expect(
      run(
        id,
        edit(
          ATH_PATHS.tokenService,
          'config.tokens.accessTokenTtl;',
          'config.tokens.accessTokenTtl; // TODO * 60',
        ),
      ),
    ).toBe(false);
  });

  it('aba-checksum-cascade', () => {
    const id = 'aba-checksum-cascade';
    const p = ABA_PATHS.checksum;
    expect(run(id, edit(p, '3 * a + 7 * c + b', '3 * a + 7 * b + 1 * c'))).toBe(true);
    expect(run(id, edit(p, '3 * a + 7 * c + b', 'a * 3 + b * 7 + c'))).toBe(true);
    expect(run(id, edit(p, '3 * a + 7 * c + b', '3 * a + c + 7 * b'))).toBe(false);
  });

  it('crd-pool-exhaustion', () => {
    const id = 'crd-pool-exhaustion';
    const p = CRD_PATHS.applicationYml;
    expect(run(id, edit(p, 'maximum-pool-size: 5', 'maximum-pool-size: 30'))).toBe(true);
    expect(run(id, edit(p, 'maximum-pool-size: 5', 'maximum-pool-size: 12'))).toBe(false);
    expect(run(id, edit(p, /\n\s+maximum-pool-size: 5/, ''))).toBe(false);
    expect(run(id, edit(p, 'connection-timeout: 2000', 'connection-timeout: 10000'))).toBe(false);
  });

  it('tlr-business-date-helpdesk', () => {
    const id = 'tlr-business-date-helpdesk';
    const yml = TLR_PATHS.applicationYml;
    expect(run(id, edit(yml, '    timezone: UTC', '    timezone: US/Eastern'))).toBe(true);
    expect(run(id, edit(yml, '    timezone: UTC', '    timezone: "America/New_York"'))).toBe(true);
    expect(run(id, edit(yml, /\n {4}timezone: UTC/, ''))).toBe(true);
    expect(run(id, edit(yml, '    timezone: UTC', '    timezone: Etc/UTC'))).toBe(false);
    expect(
      run(
        id,
        edit(
          TLR_PATHS.businessDateService,
          'return ZoneId.of(properties.getTimezone());',
          'return ZoneId.of("America/New_York");',
        ),
      ),
    ).toBe(true);
    // Jackson / Hibernate UTC settings alone are fine and must not count as the bug.
    const s = scenario(id);
    expect((afterFix(s)[yml] ?? '').includes('time-zone: UTC')).toBe(true);
  });
});

describe('the whole estate', () => {
  it('every bad MR, fix and red herring can land in sequence without conflicts', () => {
    const repos: Record<string, Files> = {};
    const repo = (project: string) => {
      repos[project] ??= overlayFiles(project);
      return repos[project]!;
    };
    for (const s of scenarios) {
      for (const r of [...(s.redHerrings ?? [])].filter((x) => x.atSec < 0)) {
        repos[r.project] = applyEdits(repo(r.project), r.edits);
      }
      repos[s.badMr.project] = applyEdits(repo(s.badMr.project), s.badMr.edits);
      for (const r of s.redHerrings ?? []) repos[r.project] = applyEdits(repo(r.project), r.edits);
      repos[s.badMr.project] = applyEdits(repo(s.badMr.project), s.fix.edits);
      const files = repo(s.badMr.project);
      expect(s.fix.isFixed(Object.fromEntries(s.fix.files.map((f) => [f, files[f] ?? null])))).toBe(
        true,
      );
    }
  });

  it('bad MRs stay inside the culprit repo and touch overlay or new files only', () => {
    for (const s of scenarios) {
      const overlay = heroRepoOverlays[s.badMr.project]!;
      for (const e of s.badMr.edits) {
        if (e.find !== undefined) expect(overlay.files[e.path], e.path).toBeDefined();
      }
    }
  });
});

describe('aba-checksum-cascade log consistency', () => {
  const weighted = (rtn: string, w: number[]) =>
    [...rtn].reduce((sum, d, i) => sum + Number(d) * w[i]!, 0) % 10 === 0;
  const real = (rtn: string) => weighted(rtn, [3, 7, 1, 3, 7, 1, 3, 7, 1]);
  const swapped = (rtn: string) => weighted(rtn, [3, 1, 7, 3, 1, 7, 3, 1, 7]);

  it('names routing numbers that are really valid, and that the broken checksum rejects', () => {
    const s = scenario('aba-checksum-cascade');
    const templates = [
      ...(s.culpritSignals?.templates ?? []),
      ...s.impacts.flatMap((i) => i.templates),
    ];
    let checked = 0;
    templates.forEach((t, i) => {
      for (let n = 0; n < 10; n++) {
        const { message } = t.render(stubContext(getApp('ACH'), `aba:${i}:${n}`));
        for (const m of message.matchAll(/(?:rtn=|routing number |ABA |RDFI )(\d{9})/g)) {
          const rtn = m[1]!;
          expect(real(rtn), rtn).toBe(true);
          expect(swapped(rtn), `${rtn} in "${message}"`).toBe(message.includes('valid=true'));
          checked++;
        }
      }
    });
    expect(checked).toBeGreaterThan(50);
  });
});
