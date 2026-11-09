import { gunzipSync } from 'node:zlib';
import type { RepoOverlay } from '@sim/scenarios';
import { getRepo, getWorld } from '@sim/world';
import { describe, expect, it, vi } from 'vitest';
import { planRepo } from './history/plan';
import { diffTrees, fileDiff, threeWayMerge } from './store/diff';
import { applyEdits } from './store/edits';
import { materialize } from './store/materialize';
import { GitlabStore } from './store/store';
import { createTarGz } from './store/tar';
import { DAY, MINUTE, type TreeMap } from './store/types';

// Hero overlays are covered with synthetic overlays below; keep these tests independent of the
// scenario package's current content.
vi.mock('@sim/scenarios', () => ({ heroRepoOverlays: {} }));

const NOW = Date.UTC(2026, 10, 9, 15, 0, 0);
const SAMPLE = [
  'keybank/PAY00/payments-api',
  'keybank/CIF00/customer-profile-api',
  'keybank/NTF00/notification-service',
  'keybank/FRD00/fraud-scoring-engine',
  'keybank/OLB00/online-banking-web',
];

const store = new GitlabStore(NOW);

function mainTree(s: GitlabStore, path: string): TreeMap {
  const state = s.project(path);
  return s.tree(state, state.branches.get('main')!.head);
}

describe('seeded instance', () => {
  it('is deterministic for a given boot time', () => {
    const other = new GitlabStore(NOW);
    expect(other.stats()).toEqual(store.stats());
    const terraform = getWorld().repos.find((r) => r.stack === 'terraform')!.path;
    for (const path of [...SAMPLE, terraform]) {
      const a = store.project(path);
      const b = other.project(path);
      expect(b.order).toEqual(a.order);
      expect(b.mrs.map((m) => [m.iid, m.title, m.state])).toEqual(
        a.mrs.map((m) => [m.iid, m.title, m.state]),
      );
      expect([...mainTree(other, path)]).toEqual([...mainTree(store, path)]);
    }
  });

  it('generates realistic, app-specific codebases', () => {
    for (const repo of getWorld().repos.slice(0, 120)) {
      const tree = mainTree(store, repo.path);
      expect(tree.size).toBeGreaterThanOrEqual(8);
      expect(tree.size).toBeLessThanOrEqual(32);
      for (const f of ['README.md', 'CHANGELOG.md', '.gitlab-ci.yml', '.gitignore'])
        expect(tree.has(f)).toBe(true);
      expect(tree.has('Dockerfile')).toBe(repo.stack !== 'terraform');
      expect(tree.get('README.md')).toContain(repo.name);
    }
    const pay = mainTree(store, 'keybank/PAY00/payments-api');
    expect(pay.has('pom.xml')).toBe(true);
    expect(pay.has('src/main/java/com/keybank/pay/client/CifClient.java')).toBe(true);
    expect(pay.get('src/main/resources/application.yml')).toContain(
      'customer-profile-api.cif00.svc.cluster.local',
    );
    const ntf = mainTree(store, 'keybank/NTF00/notification-service');
    expect(ntf.has('src/clients/cif.ts')).toBe(true);
    expect(ntf.has('src/config.ts')).toBe(true);
    const frd = mainTree(store, 'keybank/FRD00/fraud-scoring-engine');
    expect(frd.has('pyproject.toml')).toBe(true);
    expect(frd.has('src/fraud_scoring_engine/clients/cif.py')).toBe(true);
  });

  it('every seeded commit is a real change, and history respects the time windows', () => {
    for (const state of store.allProjects()) {
      const latest = state.app.hero ? NOW - DAY : NOW - 15 * MINUTE;
      for (const c of state.commits.values()) {
        expect(c.committedAt).toBeLessThanOrEqual(latest);
      }
    }
    for (const path of SAMPLE) {
      const state = store.project(path);
      materialize(state);
      for (const c of state.commits.values()) {
        if (c.parents.length === 0) continue;
        expect(store.commitDiffs(state, c).length, `${path} ${c.title}`).toBeGreaterThan(0);
      }
    }
    const stats = store.stats();
    expect(stats.open_merge_requests).toBeGreaterThan(40);
    expect(stats.merge_requests).toBeGreaterThan(1000);
  });
});

describe('FileEdit', () => {
  const tree: TreeMap = new Map([
    ['a.txt', 'one\ntwo\nthree\n'],
    ['dup.txt', 'x\nx\n'],
  ]);

  it('applies full content and find/replace in order', () => {
    const changes = applyEdits(tree, [
      { path: 'a.txt', find: 'two', replace: 'TWO' },
      { path: 'a.txt', find: 'TWO\nthree', replace: 'TWO\n3' },
      { path: 'new/file.md', content: '# hi\n' },
    ]);
    expect(changes.get('a.txt')).toBe('one\nTWO\n3\n');
    expect(changes.get('new/file.md')).toBe('# hi\n');
    expect(tree.get('a.txt')).toBe('one\ntwo\nthree\n');
  });

  it('fails with 422 unless find occurs exactly once', () => {
    expect(() => applyEdits(tree, [{ path: 'a.txt', find: 'nope', replace: '' }])).toThrow(
      /not found/,
    );
    expect(() => applyEdits(tree, [{ path: 'dup.txt', find: 'x', replace: 'y' }])).toThrow(
      /occurs 2 times/,
    );
    expect(() => applyEdits(tree, [{ path: 'missing.txt', find: 'x', replace: 'y' }])).toThrow(
      /does not exist/,
    );
    try {
      applyEdits(tree, [{ path: 'dup.txt', find: 'x', replace: 'y' }]);
    } catch (err) {
      expect((err as { status: number }).status).toBe(422);
    }
  });
});

describe('diffs and merges', () => {
  it('produces unified diffs with counts', () => {
    const d = fileDiff('a.txt', 'one\ntwo\nthree\n', 'one\n2\nthree\nfour\n');
    expect(d.additions).toBe(2);
    expect(d.deletions).toBe(1);
    expect(d.diff).toMatch(/^@@ -1,3 \+1,4 @@\n one\n-two\n\+2\n three\n\+four\n$/);
    const created = fileDiff('b.txt', undefined, 'x\ny\n');
    expect(created.new_file).toBe(true);
    expect(created.diff.startsWith('@@ -0,0 +1,2 @@')).toBe(true);
    const diffs = diffTrees(new Map([['a', '1\n']]), new Map([['b', '2\n']]));
    expect(diffs.map((x) => [x.new_path, x.new_file, x.deleted_file])).toEqual([
      ['a', false, true],
      ['b', true, false],
    ]);
  });

  it('three-way merges independent changes and detects conflicts', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const base: TreeMap = new Map([['f', lines]]);
    const target: TreeMap = new Map([['f', lines.replace('line 2\n', 'line 2 (target)\n')]]);
    const source: TreeMap = new Map([
      ['f', lines.replace('line 25\n', 'line 25 (source)\n')],
      ['g', 'new'],
    ]);
    const ok = threeWayMerge(base, target, source);
    expect(ok.conflicts).toEqual([]);
    expect(ok.tree.get('f')).toContain('line 2 (target)');
    expect(ok.tree.get('f')).toContain('line 25 (source)');
    expect(ok.tree.get('g')).toBe('new');
    const clash = threeWayMerge(
      base,
      target,
      new Map([['f', lines.replace('line 2\n', 'line 2 (source)\n')]]),
    );
    expect(clash.conflicts).toEqual(['f']);
  });
});

describe('overlays', () => {
  const repo = getRepo('keybank/CIF00/customer-profile-api');
  const javaFile = 'src/main/java/com/keybank/cif/client/AthClient.java';

  it('complete overlays replace the tree and are never modified by history', () => {
    const overlay: RepoOverlay = {
      complete: true,
      files: {
        'pom.xml': '<project>overlay</project>\n',
        [javaFile]: 'class AthClient { int readTimeoutMs = 2000; }\n',
        'src/main/resources/application.yml': 'upstream:\n  ath:\n    read-timeout: 2000ms\n',
      },
    };
    const { state } = planRepo(repo, { now: NOW, overlay, openMrs: 1, closedMrs: 0 });
    materialize(state);
    for (const c of state.commits.values()) {
      for (const [path, content] of Object.entries(overlay.files))
        expect(c.tree!.get(path)).toBe(content);
      expect(c.tree!.has('src/main/java/com/keybank/cif/service/CustomerProfileService.java')).toBe(
        false,
      );
      expect(c.tree!.has('README.md')).toBe(true);
    }
    expect(state.order.length).toBeGreaterThan(5);
  });

  it('layered overlays override template files and keep the rest', () => {
    const overlay: RepoOverlay = { complete: false, files: { [javaFile]: 'class AthClient {}\n' } };
    const { state } = planRepo(repo, { now: NOW, overlay, openMrs: 0, closedMrs: 0 });
    materialize(state);
    const head = state.commits.get(state.branches.get('main')!.head)!;
    expect(head.tree!.get(javaFile)).toBe('class AthClient {}\n');
    expect(head.tree!.has('pom.xml')).toBe(true);
    for (const c of state.commits.values()) {
      expect(c.tree!.get(javaFile)).toBe('class AthClient {}\n');
      if (c.parents.length === 1) {
        const parent = state.commits.get(c.parents[0]!)!;
        const changed = diffTrees(parent.tree, c.tree!).map((d) => d.new_path);
        expect(changed.length).toBeGreaterThan(0);
        expect(changed).not.toContain(javaFile);
      }
    }
  });
});

describe('write flows', () => {
  it('admin merge lands on main and is readable as raw files', () => {
    const s = new GitlabStore(NOW);
    const path = 'keybank/CIF00/customer-profile-api';
    const before = mainTree(s, path).get('src/main/resources/application.yml')!;
    const { mr, merge } = s.adminMerge({
      project: path,
      title: 'CIF-1: lower timeout',
      description: 'x',
      author: 'svc_incident_auto',
      merged_by: 'dwhitfield',
      source_branch: 'feature/cif-1',
      edits: [
        {
          path: 'src/main/resources/application.yml',
          find: '  port: 8080',
          replace: '  port: 9090',
        },
      ],
    });
    expect(mr.state).toBe('merged');
    expect(merge.parents).toHaveLength(2);
    const after = mainTree(s, path).get('src/main/resources/application.yml')!;
    expect(after).toBe(before.replace('  port: 8080', '  port: 9090'));
    expect(() =>
      s.adminMerge({
        project: path,
        title: 'bad',
        description: '',
        author: 'a',
        merged_by: 'b',
        source_branch: 'feature/cif-1',
        edits: [{ path: 'README.md', find: 'definitely not there', replace: '' }],
      }),
    ).toThrow(/not found/);
  });

  it('merge requests merge cleanly or report conflicts', () => {
    const s = new GitlabStore(NOW);
    const state = s.project('keybank/PAY00/payments-api');
    const edit = (replace: string) => [{ path: 'Dockerfile', find: 'EXPOSE 8080', replace }];
    const a = s.createMr(state, {
      source_branch: 'fix/a',
      title: 'A',
      changes: edit('EXPOSE 8081'),
    });
    const b = s.createMr(state, {
      source_branch: 'fix/b',
      title: 'B',
      changes: edit('EXPOSE 8082'),
    });
    expect(s.mergeStatus(state, b)).toBe('can_be_merged');
    s.mergeMr(state, a, 'dwhitfield');
    expect(mainTree(s, 'keybank/PAY00/payments-api').get('Dockerfile')).toContain('EXPOSE 8081');
    expect(s.mergeStatus(state, b)).toBe('cannot_be_merged');
    expect(() => s.mergeMr(state, b, 'dwhitfield')).toThrow(/conflict/i);
    expect(state.branches.has('fix/a')).toBe(false);
  });
});

describe('tar archive', () => {
  it('writes a valid gzipped ustar archive', () => {
    const long = `${'deep/'.repeat(25)}File.java`;
    const gz = createTarGz(
      'repo-main',
      [
        { path: 'README.md', content: '# hi\n' },
        { path: long, content: 'class File {}\n' },
      ],
      NOW,
    );
    const tar = gunzipSync(gz);
    expect(tar.length % 512).toBe(0);
    const names: string[] = [];
    for (let off = 0; off + 512 <= tar.length; ) {
      const header = tar.subarray(off, off + 512);
      if (header.every((b) => b === 0)) break;
      const name = header.subarray(0, 100).toString().replace(/\0.*$/, '');
      const prefix = header.subarray(345, 500).toString().replace(/\0.*$/, '');
      const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, ''), 8);
      expect(header.subarray(257, 262).toString()).toBe('ustar');
      names.push(prefix ? `${prefix}/${name}` : name);
      off += 512 + Math.ceil(size / 512) * 512;
    }
    expect(names).toContain('repo-main/README.md');
    expect(names).toContain(`repo-main/${long}`);
  });
});
