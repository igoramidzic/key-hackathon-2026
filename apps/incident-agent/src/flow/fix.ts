/**
 * The fix (#22): generated in the background once the root cause is confident, validated against
 * `main`, opened as a GitLab merge request for humans to review and merge.
 *
 * Deterministic strategy: revert the culprit MR's hunks with exact find/replace edits (each
 * `find` must occur exactly once on main). With Claude enabled a read-only phase may propose a
 * forward fix instead; it is held to the same validation and retried once with the error.
 */
import { ensureOnce } from '../actions/ensure';
import type { Case, FileChange, FixProposal } from '../cases/types';
import { FixProposal as FixSchema } from '../cases/types';
import { errorMessage, slugify } from '../util';
import { addLinks } from './incident';
import { type MrDetail, username } from './rca';
import type { FlowDeps } from './steps';

interface Hunk {
  oldText: string;
  newText: string;
}

/** Splits a unified diff into hunks: the old side (context + removed) and new side (context + added). */
export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: { old: string[]; new: string[] } | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      if (cur) hunks.push({ oldText: cur.old.join('\n'), newText: cur.new.join('\n') });
      cur = { old: [], new: [] };
      continue;
    }
    if (!cur || line.startsWith('\\')) continue;
    const tag = line[0];
    const text = line.slice(1);
    if (tag === ' ' || line === '') {
      cur.old.push(text);
      cur.new.push(text);
    } else if (tag === '-') cur.old.push(text);
    else if (tag === '+') cur.new.push(text);
  }
  if (cur) hunks.push({ oldText: cur.old.join('\n'), newText: cur.new.join('\n') });
  // Trailing context lines that are empty come from the diff's final newline.
  return hunks.map((h) => ({
    oldText: h.oldText.replace(/\n+$/, ''),
    newText: h.newText.replace(/\n+$/, ''),
  }));
}

export function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/** Builds revert edits for one file against its current content on main. */
export function revertEdits(
  path: string,
  diff: string,
  current: string,
): { edits: FileChange[]; problems: string[] } {
  const edits: FileChange[] = [];
  const problems: string[] = [];
  for (const h of parseHunks(diff)) {
    if (h.oldText === h.newText) continue;
    if (occurrences(current, h.newText) === 1) {
      edits.push({ path, find: h.newText, replace: h.oldText });
      continue;
    }
    // Context drifted: retry with only the changed lines (still must be unique).
    const newLines = h.newText.split('\n');
    const oldLines = h.oldText.split('\n');
    let start = 0;
    while (
      start < Math.min(newLines.length, oldLines.length) &&
      newLines[start] === oldLines[start]
    )
      start++;
    let endN = newLines.length;
    let endO = oldLines.length;
    while (endN > start && endO > start && newLines[endN - 1] === oldLines[endO - 1]) {
      endN--;
      endO--;
    }
    const find = newLines.slice(start, endN).join('\n');
    const replace = oldLines.slice(start, endO).join('\n');
    if (find && occurrences(current, find) === 1) edits.push({ path, find, replace });
    else
      problems.push(
        `${path}: hunk not found exactly once on main (${occurrences(current, h.newText)} matches)`,
      );
  }
  return { edits, problems };
}

/** Validates a proposal against main: files exist, every find is unique, only culprit files. */
export async function validateFix(
  deps: FlowDeps,
  c: Case,
  fix: FixProposal,
  allowed: string[],
): Promise<string[]> {
  const problems: string[] = [];
  if (!fix.changes.length) problems.push('the fix has no changes');
  const files = new Map<string, string | null>();
  for (const ch of fix.changes) {
    if (allowed.length && !allowed.includes(ch.path))
      problems.push(`${ch.path} is not part of the culprit change (${allowed.join(', ')})`);
    if (ch.content === undefined && ch.find === undefined)
      problems.push(`${ch.path}: needs content or find/replace`);
    if (ch.find === undefined) continue;
    if (!files.has(ch.path)) {
      try {
        const f = await deps.mcp.call<{ content: string }>(
          'get_file',
          { project: fix.project, path: ch.path, ref: 'main' },
          { caseId: c.id },
        );
        files.set(ch.path, f.content);
      } catch {
        files.set(ch.path, null);
      }
    }
    const content = files.get(ch.path);
    if (content === null || content === undefined)
      problems.push(`${ch.path} does not exist on main`);
    else {
      const n = occurrences(content, ch.find);
      if (n !== 1)
        problems.push(`${ch.path}: find text occurs ${n} times on main (must be exactly once)`);
    }
  }
  return problems;
}

function culpritMr(c: Case) {
  return c.root_cause?.merge_request ?? c.suspects[0]?.merge_request ?? null;
}

function fixDescription(
  deps: FlowDeps,
  c: Case,
  mr: MrDetail,
  strategy: string,
  summary: string,
): string {
  const rc = c.root_cause;
  const lines = [
    `## ${c.incident ? `[${c.incident.number}](${c.incident.web_url})` : 'Incident'}: ${c.scope?.summary ?? ''}`,
    '',
    `**Root cause:** [${mr.project}!${mr.iid}](${mr.web_url}) "${mr.title}"${rc?.change_request ? `, promoted by [${rc.change_request.number}](${rc.change_request.web_url})` : ''}.`,
    rc?.mechanism ?? '',
    '',
    `**This MR:** ${summary}`,
    '',
    '**Evidence:**',
    ...(rc?.evidence ?? []).slice(0, 5).map((e) => `- [${e.claim}](${e.web_url})`),
    ...(c.scope?.log_links ?? []).slice(0, 2).map((l) => `- [${l.label}](${l.logs_url})`),
    '',
    `**Risk:** ${strategy === 'revert' ? 'low: restores the behaviour that ran in production before the change; the change itself goes back to its author to redo' : 'moderate: forward fix, review the diff closely'}.`,
    '',
    `**How to verify:** after merge an emergency change promotes it to production; errors on ${
      (c.scope?.affected_apps ?? [])
        .filter((a) => a.error_count > 0)
        .slice(0, 5)
        .map((a) => a.tla)
        .join(', ') || 'the affected apps'
    } should drop back to baseline within minutes. Incident Automation watches the logs and reports in the incident channel.`,
  ];
  return lines.join('\n');
}

/** The deterministic proposal: revert the culprit MR. */
export async function revertProposal(
  deps: FlowDeps,
  c: Case,
): Promise<{ fix: FixProposal | null; problems: string[]; allowed: string[] }> {
  const ref = culpritMr(c);
  if (!ref) return { fix: null, problems: ['no culprit merge request'], allowed: [] };
  const mr = await deps.mcp.call<MrDetail>(
    'get_merge_request',
    { project: ref.project, iid: ref.iid },
    { caseId: c.id },
  );
  const changes: FileChange[] = [];
  const problems: string[] = [];
  const allowed = (mr.changes ?? []).map((ch) => ch.path);
  for (const ch of mr.changes ?? []) {
    if (ch.new_file || ch.deleted_file) {
      problems.push(
        `${ch.path}: ${ch.new_file ? 'added' : 'deleted'} by the MR; can't revert a whole file with find/replace`,
      );
      continue;
    }
    const file = await deps.mcp.call<{ content: string }>(
      'get_file',
      { project: mr.project, path: ch.path, ref: 'main' },
      { caseId: c.id },
    );
    const r = revertEdits(ch.path, ch.diff, file.content);
    changes.push(...r.edits);
    problems.push(...r.problems);
  }
  if (!changes.length)
    return { fix: null, problems: problems.length ? problems : ['nothing to revert'], allowed };
  const inc = c.incident?.number ?? 'incident';
  const fix: FixProposal = {
    project: mr.project,
    strategy: 'revert',
    justification: `the culprit change is self-contained (${allowed.length} file${allowed.length === 1 ? '' : 's'}); reverting restores the last known-good behaviour fastest`,
    changes,
    title: `Revert "${mr.title}" (${inc})`.slice(0, 200),
    description: fixDescription(
      deps,
      c,
      mr,
      'revert',
      `reverts ${mr.project}!${mr.iid} hunk by hunk on top of main${problems.length ? ` (could not revert: ${problems.join('; ')})` : ''}.`,
    ),
  };
  return { fix, problems, allowed };
}

const FIX_TOOLS = [
  'get_merge_request',
  'get_commit',
  'get_file',
  'get_file_tree',
  'fetch_repository',
  'compare_refs',
  'get_project',
];

const FIX_SYSTEM = `You write the fix for a production incident at a bank. You are read-only: read the code with
the tools and answer with a FixProposal JSON; the orchestrator opens the merge request. Prefer the
smallest safe change. A revert of the culprit change is usually right; choose a forward fix only when
a revert is unsafe or impossible, and say why. Edits are find/replace pairs on the exact current text
of files on main (each find must occur exactly once; include surrounding lines to make it unique) or
full file content. Touch only files related to the culprit change. Never invent URLs: the description
may only use links given in the prompt.`;

/** Proposal: LLM (validated, one retry) when available, else the deterministic revert. */
export async function proposeFix(
  deps: FlowDeps,
  c: Case,
): Promise<{ fix: FixProposal | null; source: 'llm' | 'heuristic'; problems: string[] }> {
  const draft = await revertProposal(deps, c);
  if (!deps.runner || !culpritMr(c))
    return { fix: draft.fix, source: 'heuristic', problems: draft.problems };
  const ref = culpritMr(c)!;
  let feedback = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = await deps.runner.run({
      name: 'fix',
      caseId: c.id,
      system: FIX_SYSTEM,
      prompt: [
        `Incident ${c.incident?.number ?? ''} (${c.incident?.web_url ?? ''}): ${c.scope?.summary ?? ''}`,
        `Root cause: ${JSON.stringify(c.root_cause ?? c.suspects[0], null, 2)}`,
        `Culprit MR: ${ref.project}!${ref.iid} (${ref.web_url})`,
        draft.fix
          ? `A mechanical revert that validates against main:\n${JSON.stringify(draft.fix, null, 2)}`
          : `A mechanical revert is not possible: ${draft.problems.join('; ')}`,
        feedback,
        'Return the FixProposal JSON (project, strategy, justification, changes, title, description). Put the incident number in the title.',
      ].join('\n\n'),
      tools: FIX_TOOLS,
      schema: FixSchema,
      model: deps.runner.models.deep,
      maxTurns: 25,
      timeoutMs: 5 * 60_000,
    });
    if (!out.ok) break;
    const problems = await validateFix(deps, c, out.value, draft.allowed);
    if (problems.length === 0) return { fix: out.value, source: 'llm', problems: [] };
    feedback = `Your previous proposal failed validation:\n- ${problems.join('\n- ')}\nFix these and answer again.`;
    deps.store.event(
      c,
      'llm',
      `fix proposal rejected (attempt ${attempt}): ${problems.join('; ')}`,
    );
  }
  return { fix: draft.fix, source: 'heuristic', problems: draft.problems };
}

export function fixBranch(c: Case): string {
  const inc = (c.incident?.number ?? c.id).toLowerCase();
  return `fix/${inc}-${slugify(c.root_cause?.culprit_tla ?? c.scope?.summary ?? 'fix', 30)}`;
}

interface CreatedMr {
  project: string;
  iid: number;
  web_url: string;
  state: string;
  source_branch: string;
}

/** Opens the MR (idempotent by source branch), notes the culprit MR, links the incident. */
export async function openFixMr(
  deps: FlowDeps,
  c: Case,
  fix: FixProposal,
): Promise<'existing' | 'found' | 'created'> {
  const branch = fixBranch(c);
  const { how } = await ensureOnce({
    current: () => c.fix_mr,
    lookup: async () => {
      const res = await deps.mcp.call<{ items: CreatedMr[] }>(
        'list_merge_requests',
        { project: fix.project, state: 'all', labels: ['incident'], limit: 50 },
        { caseId: c.id },
      );
      const mr = res.items.find((m) => m.source_branch === branch);
      return mr
        ? {
            project: fix.project,
            iid: mr.iid,
            web_url: mr.web_url,
            state: mr.state,
            source_branch: branch,
            merged_at: null,
            merge_commit_sha: null,
          }
        : null;
    },
    create: async () => {
      const mr = await deps.mcp.call<CreatedMr>(
        'create_merge_request',
        {
          project: fix.project,
          title: fix.title,
          description: fix.description,
          source_branch: branch,
          target_branch: 'main',
          changes: fix.changes,
          labels: ['incident', fix.strategy === 'revert' ? 'revert' : 'bug'],
          commit_message: `${fix.title}\n\n${c.incident ? `${c.incident.number}: ${c.incident.web_url}` : ''}`,
        },
        { caseId: c.id },
      );
      return {
        project: fix.project,
        iid: mr.iid,
        web_url: mr.web_url,
        state: mr.state ?? 'opened',
        source_branch: branch,
        merged_at: null,
        merge_commit_sha: null,
      };
    },
    record: (value) => {
      c.fix_mr = value;
      c.fix = fix;
      deps.store.save(c);
    },
  });
  if (how !== 'existing') {
    const culprit = culpritMr(c);
    if (culprit && how === 'created') {
      try {
        await deps.mcp.call(
          'add_merge_request_note',
          {
            project: culprit.project,
            iid: culprit.iid,
            body: `This change caused ${c.incident ? `[${c.incident.number}](${c.incident.web_url})` : 'an incident'} (${c.scope?.summary ?? ''}). Fix for review: [${c.fix_mr!.project}!${c.fix_mr!.iid}](${c.fix_mr!.web_url}).`,
          },
          { caseId: c.id },
        );
      } catch (err) {
        deps.log.warn(`${c.id} note on culprit MR failed: ${errorMessage(err)}`);
      }
    }
    await addLinks(
      deps,
      c,
      [
        {
          type: 'merge_request',
          url: c.fix_mr!.web_url,
          title: `Fix: ${c.fix_mr!.project}!${c.fix_mr!.iid}`,
        },
      ],
      `Fix merge request opened for review: ${c.fix_mr!.web_url} (${fix.strategy}). ${fix.justification}`,
    );
  }
  deps.store.event(
    c,
    'action',
    `${how === 'created' ? 'Opened' : 'Adopted'} fix ${c.fix_mr!.project}!${c.fix_mr!.iid} (${fix.strategy})`,
    { url: c.fix_mr!.web_url },
  );
  return how;
}

/** Who to ask for review: the culprit MR's author and the culprit app's on-call. */
export async function reviewers(deps: FlowDeps, c: Case): Promise<string[]> {
  const out: string[] = [];
  const ref = culpritMr(c);
  if (ref) {
    try {
      const mr = await deps.mcp.call<MrDetail>(
        'get_merge_request',
        { project: ref.project, iid: ref.iid },
        { caseId: c.id, quiet: true },
      );
      const a = username(mr.author);
      if (a) out.push(a);
    } catch {
      // the on-call still reviews
    }
  }
  const tla = c.root_cause?.culprit_tla ?? c.suspects[0]?.tla;
  const oncall = tla ? deps.graph().nodes.get(tla)?.on_call?.primary : null;
  if (oncall) out.push(oncall);
  return [...new Set(out)].filter((u) => u !== deps.config.identity);
}
