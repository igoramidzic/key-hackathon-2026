import { getWorld, PERSONAS, SHARED_GROUP_IDS } from '@sim/world';
import { BOT, type TeamsStore } from './store';

export const INCIDENT_TEAM_ID = 'incident-response';

/**
 * Deterministic, deliberately minimal seed: one team with one General channel and a few pinned-style
 * messages. Incident channels are created at runtime (by the agent through MCP, or by people in the
 * UI) inside this team. Every world person exists as a Teams user regardless of team membership.
 * Timestamps are relative to `now` (process start or last reset).
 */
export function seedStore(store: TeamsStore, now: Date) {
  const world = getWorld();
  const H = 3_600_000;
  const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * H);
  const longAgo = at(24 * 365);

  const groupMembers = (id: string) => world.groupsById.get(id)?.memberUsernames ?? [];
  const members = [
    ...new Set([
      BOT,
      PERSONAS.nocLead,
      ...groupMembers(SHARED_GROUP_IDS.noc),
      ...groupMembers(SHARED_GROUP_IDS.majorIncident),
    ]),
  ].filter((u) => world.peopleByUsername.has(u));

  store.createTeam({
    id: INCIDENT_TEAM_ID,
    name: 'Incident Response',
    description:
      'Incident coordination. Incident channels (inc<number>-<short-slug>) are created here.',
    members,
    at: longAgo,
  });

  const { channel: general } = store.createChannel(
    {
      team_id: INCIDENT_TEAM_ID,
      name: 'general',
      display_name: 'General',
      description: 'Announcements for the Incident Response team.',
      created_by: PERSONAS.nocLead,
      members: members.filter((u) => u !== PERSONAS.nocLead).map((user) => ({ user })),
    },
    longAgo,
    { silent: true },
  );

  const messages: [hoursAgo: number, author: string, body: string][] = [
    [
      72,
      BOT,
      'Incident channels are created in this team and named `inc<number>-<short-slug>`, for example `inc0012345-payments-timeouts`.',
    ],
    [
      48,
      PERSONAS.majorIncidentManager,
      'Reminder: for P1/P2s, post a status update in the incident channel at least every 30 minutes, even if nothing changed.',
    ],
    [
      20,
      PERSONAS.nocLead,
      "When you add someone to an incident channel, include the reason so they know why they're there.",
    ],
  ];
  for (const [hoursAgo, author, body] of messages) {
    store.postMessage(general, { author, body }, at(hoursAgo));
  }

  // Seeded history is old news: everything starts read.
  for (const n of store.notifications) n.read = true;
}
