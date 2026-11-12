/**
 * The guided demo's script: an ordered list of beats, each saying what to show, what to point at
 * and whether it has happened yet. Pure: everything comes from the simulator's run status and the
 * agent's case, so the same script follows any scenario at any speed.
 */
import { URLS } from '@sim/contracts';
import type { RunStatus } from '@sim/contracts/simulator';
import type { DemoTarget } from '@sim/ui';
import type { Beat, CaseView } from './types';

export interface StoryInput {
  /** The tour has started (the world was reset). */
  started: boolean;
  /** The agent has watched a quiet world long enough to know what normal looks like. */
  baselineReady: boolean;
  /** This run, once triggered. */
  run: RunStatus | null;
  /** The case the agent opened for it. */
  view: CaseView | null;
}

const BOT = 'svc_incident_auto';
const demo = (name: string) => `[data-demo="${name}"]`;

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

export function logsUrl(query: string, range = '15m'): string {
  const q = new URLSearchParams({ range });
  if (query) q.set('query', query);
  return `${URLS.logs.web}/logs?${q}`;
}

/** Turn on the Logs Explorer's live stream, unless it is already on. */
const STREAM: { target: DemoTarget; unless: DemoTarget } = {
  target: { sel: 'button', text: 'Stream logs' },
  unless: { sel: 'button', text: 'Stop stream' },
};

const PHASE_ORDER = [
  'detected',
  'triaged',
  'declared',
  'assembled',
  'briefed',
  'investigating',
  'fix_proposed',
  'awaiting_merge',
  'shipping',
  'verifying',
  'resolution_drafted',
  'resolved',
];
const reached = (view: CaseView | null, phase: string) =>
  !!view && PHASE_ORDER.indexOf(view.phase) >= PHASE_ORDER.indexOf(phase);

export function buildStory(input: StoryInput): Beat[] {
  const { run, view } = input;
  const r = view?.records;
  const ms = r?.milestones ?? {};
  const apps = view?.apps.length ?? 0;
  const inc = r?.incident;
  const affected = (view?.apps ?? []).slice(0, 12).map((t) => `labels.app_tla="${t}"`);
  const recoveryUrl =
    r?.verification?.logs_url ??
    logsUrl(affected.length ? `severity>=ERROR AND (${affected.join(' OR ')})` : 'severity>=ERROR');
  const alertIds = [
    ...new Set([...(run?.alerts ?? []).map((a) => a.id), ...(r?.alerts ?? []).map((a) => a.id)]),
  ].slice(0, 6);
  const culpritMr = r?.culprit?.merge_request;
  const merged = r?.fix_mr?.state === 'merged' || !!ms.shipping;
  // The agent was asked to leave the emergency change as a draft for a person to promote.
  const reviewing = !!ms.change_review;
  const promotedByPerson =
    !!ms.change_submitted || (reviewing && !!r?.change && r.change.state !== 'new');
  const v = r?.verification;
  const recovered =
    !!ms['announce:recovered'] || !!v?.healthy_since || reached(view, 'resolution_drafted');
  const rate = (n: number) => Math.round(n).toLocaleString();
  const problem = r?.problem;
  const closedOut = reached(view, 'resolution_drafted');

  const beats: Beat[] = [
    {
      id: 'meet',
      chapter: 'Setup',
      title: 'A bank, and the four tools that run it',
      say: 'Everything here is simulated: 400 applications, and the systems its IT teams use every day.',
      ready: input.started,
      panes: [{ kind: 'native', view: 'intro' }],
      dwell: 7,
    },
    {
      id: 'calm',
      chapter: 'Setup',
      title: 'A normal afternoon',
      say: 'Logs flow in and nothing is wrong. The agent is learning what normal looks like.',
      ready: input.started,
      panes: [
        {
          kind: 'frame',
          screen: 'logs',
          url: logsUrl(''),
          what: 'All logs',
          click: STREAM,
          plain: true,
        },
      ],
      dwell: 7,
    },
    {
      id: 'change',
      chapter: 'Detect',
      title: 'A routine change ships',
      say: 'Changes go to production all day. One of them is about to break something.',
      ready: input.baselineReady,
      at: run?.started_at,
      panes: [
        {
          kind: 'frame',
          screen: 'servicenow',
          url: `${URLS.servicenow.web}/change_requests`,
          what: 'Change requests',
          plain: true,
        },
      ],
      dwell: 6,
    },
    {
      id: 'errors',
      chapter: 'Detect',
      title: 'Errors appear',
      say: 'Within seconds the agent notices the spike and opens a case. No alert has fired yet.',
      ready: !!run?.fault_onset_at || (!!run && !!view),
      at: run?.fault_onset_at ?? view?.opened_at,
      panes: [
        {
          kind: 'frame',
          screen: 'logs',
          url: logsUrl('severity>=ERROR'),
          what: 'Errors only',
          click: STREAM,
          plain: true,
        },
      ],
      dwell: 8,
    },
    {
      id: 'alerts',
      chapter: 'Detect',
      title: 'Then the alerts start',
      say: 'Each alert is on a different application. This is when people would start getting paged.',
      ready: alertIds.length > 0,
      panes: [
        {
          kind: 'frame',
          screen: 'alerts',
          url: `${URLS.logs.web}/alerts?status=active`,
          what: 'Active alerts',
          plain: true,
        },
      ],
      dwell: 6,
      optional: true,
    },
    {
      id: 'onecase',
      chapter: 'Detect',
      title: 'One problem, not dozens',
      say: `${apps} applications are failing. The agent works out they are the same problem and keeps one case.`,
      ready: apps >= 3,
      panes: [{ kind: 'native', view: 'blast' }],
      dwell: 7,
      optional: true,
    },
    {
      id: 'triage',
      chapter: 'Triage',
      title: 'How bad is it?',
      say: 'Gemini reads the logs and the application catalog, and sizes it up.',
      ready: !!r?.scope,
      at: ms.triaged,
      panes: [{ kind: 'native', view: 'triage' }],
      dwell: 9,
    },
    {
      id: 'incident',
      chapter: 'Mobilize',
      title: 'It opens the parent incident',
      say: 'Priority is set, and it goes straight to the team that owns the suspect application.',
      ready: !!inc,
      at: ms.declared,
      panes: inc
        ? [
            {
              kind: 'frame',
              screen: 'servicenow',
              url: inc.web_url,
              what: inc.number,
              spots: [{ sel: demo('field:priority') }, { sel: demo('field:assignment-group') }],
            },
          ]
        : [],
      dwell: 9,
    },
    {
      id: 'cis',
      chapter: 'Mobilize',
      title: 'Every affected system is on the record',
      say: `The incident lists all ${plural(apps, 'application')} it touches, not just the one it is filed against.`,
      ready: !!inc && apps > 1,
      panes: inc
        ? [
            {
              kind: 'frame',
              screen: 'servicenow',
              url: inc.web_url,
              what: inc.number,
              spots: [{ sel: demo('section:affected-cis') }],
            },
          ]
        : [],
      dwell: 5,
      optional: true,
    },
    {
      id: 'callers',
      chapter: 'Mobilize',
      title: 'Tickets about the same problem are grouped under it',
      say: `Branch staff called the help desk about this too. Their ${plural(r?.children.length ?? 0, 'ticket')} now ${(r?.children.length ?? 0) === 1 ? 'sits' : 'sit'} under this one incident.`,
      ready: (r?.children.length ?? 0) > 0,
      panes: inc
        ? [
            {
              kind: 'frame',
              screen: 'servicenow',
              url: inc.web_url,
              what: inc.number,
              spots: [{ sel: demo('section:child-incidents') }],
            },
          ]
        : [],
      dwell: 6,
      optional: true,
    },
    {
      id: 'channel',
      chapter: 'Mobilize',
      title: 'One chat, with the right people in it',
      say: `Named for the incident, with ${plural(r?.members.length ?? 0, 'person', 'people')} added. Each is told why they are there.`,
      ready: !!r?.channel,
      at: ms.assembled,
      panes: r?.channel
        ? [
            {
              kind: 'frame',
              screen: 'teams',
              url: r.channel.web_url,
              what: `#${r.channel.name}`,
              click: {
                target: { sel: 'button[title="Members"]' },
                unless: { sel: demo('members') },
              },
              plain: true,
            },
          ]
        : [],
      dwell: 9,
    },
    {
      id: 'briefing',
      chapter: 'Mobilize',
      title: 'And briefs them',
      say: 'One message: impact, timeline, the leading suspect and links to the evidence.',
      ready: !!ms['announce:briefing'],
      at: ms['announce:briefing'],
      panes: r?.channel
        ? [
            {
              kind: 'frame',
              screen: 'teams',
              url: r.channel.web_url,
              what: `#${r.channel.name}`,
              spots: [{ sel: `${demo('message')}[data-author="${BOT}"]`, nth: 0 }],
            },
          ]
        : [],
      dwell: 9,
    },
    {
      id: 'call',
      chapter: 'Mobilize',
      title: 'It turns the chat into a call',
      say: 'Everyone is prompted to join. Recording, transcription and the Facilitator are already on.',
      ready: !!r?.meeting,
      at: ms.meeting_started,
      panes: r?.channel
        ? [
            {
              kind: 'frame',
              screen: 'teams',
              url: r.channel.web_url,
              what: `#${r.channel.name}`,
              spots: [{ sel: demo('meeting') }],
            },
          ]
        : [],
      dwell: 6,
      optional: true,
    },
    {
      id: 'rootcause',
      chapter: 'Root cause',
      title: 'It finds the cause',
      say: 'It checks GitLab for recent changes, rules out the ones that do not fit, names the one responsible and suggests a fix.',
      ready: !!r?.culprit,
      at: ms.root_cause,
      panes: [{ kind: 'native', view: 'rootcause' }],
      dwell: 14,
    },
    {
      id: 'culprit',
      chapter: 'Root cause',
      title: 'This is the change',
      say: 'It passed review, and the service it changed never returned an error itself.',
      ready: !!culpritMr,
      panes: culpritMr
        ? [
            {
              kind: 'frame',
              screen: 'gitlab',
              url: `${culpritMr.web_url}/diffs`,
              what: `Merge request !${culpritMr.iid}`,
              spots: [{ sel: demo('diff-file'), nth: 0 }],
            },
          ]
        : [],
      dwell: 9,
      optional: true,
    },
    {
      id: 'fix',
      chapter: 'Fix',
      title: 'It writes the fix',
      say: 'A merge request with the fix, explaining the cause and the evidence.',
      ready: !!r?.fix_mr,
      at: ms.fix_proposed,
      panes: r?.fix_mr
        ? [
            {
              kind: 'frame',
              screen: 'gitlab',
              url: r.fix_mr.web_url,
              what: `Merge request !${r.fix_mr.iid}`,
              plain: true,
            },
          ]
        : [],
      dwell: 7,
    },
    {
      id: 'merge',
      chapter: 'Fix',
      title: merged ? 'Merged' : 'Your turn: merge it',
      say: 'This decision stays with a person. The agent cannot merge, on purpose.',
      ready: !!r?.fix_mr && (reached(view, 'awaiting_merge') || merged),
      at: ms.awaiting_merge,
      panes: r?.fix_mr
        ? [
            {
              kind: 'frame',
              screen: 'gitlab',
              url: r.fix_mr.web_url,
              what: `Merge request !${r.fix_mr.iid}`,
              spots: merged
                ? [{ sel: demo('merge-widget') }]
                : [{ sel: demo('merge-button'), tone: 'click', label: 'Click Merge' }],
            },
          ]
        : [],
      action: { label: 'Click Merge', done: merged },
      dwell: 3,
    },
    {
      id: 'change-review',
      chapter: 'Ship',
      title: reviewing
        ? 'It drafts the change and asks a person to check it'
        : 'It creates the change request and links it in the chat',
      say: 'The emergency change request is in ServiceNow. The link goes in the chat, so someone can review it and edit it.',
      ready: !!r?.change && !!r?.channel,
      at: ms.change_review ?? ms.shipping,
      panes: r?.channel
        ? [
            {
              kind: 'frame',
              screen: 'teams',
              url: r.channel.web_url,
              what: `#${r.channel.name}`,
              spots: [
                {
                  sel: `${demo('message')}[data-author="${BOT}"]`,
                  text: 'Emergency change',
                  nth: 'last',
                },
              ],
            },
          ]
        : [],
      dwell: 8,
      optional: true,
    },
    {
      id: 'promote',
      chapter: 'Ship',
      title: promotedByPerson ? 'Promoted' : 'Your turn: review it and promote',
      say: 'A person reads the change request, edits anything that needs it, and sends it to production.',
      ready: reviewing && !!r?.change,
      panes: r?.change
        ? [
            {
              kind: 'frame',
              screen: 'servicenow',
              url: r.change.web_url,
              what: r.change.number,
              spots: promotedByPerson
                ? [{ sel: demo('field:state') }]
                : [{ sel: demo('promote-button'), tone: 'click', label: 'Click Promote now' }],
            },
          ]
        : [],
      action: { label: 'Click Promote now', done: promotedByPerson },
      dwell: 3,
      optional: true,
    },
    {
      id: 'ship',
      chapter: 'Ship',
      title: 'The change request, open to review and edit',
      say: 'Raised by the agent with the fix, the reason and the back-out plan filled in. A person can change any of it.',
      ready: !reviewing && !!r?.change,
      at: ms.shipping,
      panes: r?.change
        ? [
            {
              kind: 'frame',
              screen: 'servicenow',
              url: r.change.web_url,
              what: r.change.number,
              plain: true,
            },
          ]
        : [],
      dwell: 8,
      optional: true,
    },
    {
      id: 'verify',
      chapter: 'Recover',
      title: 'Then checks it actually worked',
      say:
        v?.after_per_min != null
          ? `Errors on the affected applications: ${rate(v.before_per_min)} a minute before the fix, ${rate(v.after_per_min)} now.`
          : 'It watches the error rate on every affected application until it is back to normal.',
      ready: reached(view, 'verifying'),
      at: ms.verifying,
      panes: [
        {
          kind: 'frame',
          screen: 'logs',
          url: recoveryUrl,
          what: 'Errors on the affected applications',
          click: STREAM,
          plain: true,
        },
      ],
      dwell: 9,
    },
    {
      id: 'recovered',
      chapter: 'Recover',
      title: 'All clear',
      say: 'The agent tells the chat it is fixed. Now the paperwork, which it also does.',
      ready: recovered,
      at: ms['announce:recovered'],
      panes: r?.channel
        ? [
            {
              kind: 'frame',
              screen: 'teams',
              url: r.channel.web_url,
              what: `#${r.channel.name}`,
              spots: [{ sel: `${demo('message')}[data-author="${BOT}"]`, nth: 'last' }],
            },
          ]
        : [],
      dwell: 7,
    },
  ];

  beats.push(
    {
      id: 'resolution',
      chapter: 'Close out',
      title: 'It fills out the incident',
      say: 'The Resolution section: cause code, the change that caused it, the change that fixed it, the outage window and the impact.',
      ready: !!r?.resolution?.fields && Object.keys(r.resolution.fields).length > 0,
      at: r?.resolution?.drafted_at,
      panes: inc
        ? [
            {
              kind: 'frame',
              screen: 'servicenow',
              url: inc.web_url,
              what: inc.number,
              spots: [{ sel: demo('section:resolution') }],
            },
          ]
        : [],
      dwell: 13,
      optional: true,
    },
    {
      id: 'problem',
      chapter: 'Close out',
      title: 'It opens the problem record',
      say: "What happened, why, and what stops a repeat. It is already on the agenda for tomorrow's 8 AM problem stand-up.",
      ready: !!problem,
      at: ms.problem_opened,
      panes: problem
        ? [
            {
              kind: 'frame',
              screen: 'servicenow',
              url: problem.web_url,
              what: problem.number,
              plain: true,
            },
          ]
        : [],
      dwell: 11,
      optional: true,
    },
  );

  beats.push({
    id: 'recap',
    chapter: 'Close out',
    title: 'First error to fixed',
    say: 'The agent did the legwork. A person made the one decision that mattered.',
    ready: recovered && (closedOut || view?.open === false),
    panes: [{ kind: 'native', view: 'recap' }],
    dwell: 3600,
  });

  // A beat with nothing to show (its record does not exist yet) is not ready, whatever it says.
  return beats.map((b) => (b.panes.length === 0 ? { ...b, ready: false } : b));
}
