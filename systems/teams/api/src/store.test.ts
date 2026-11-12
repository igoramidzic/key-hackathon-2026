import { describe, expect, it } from 'vitest';
import { seedStore } from './seed';
import {
  defaultDisplayName,
  formatDuration,
  normalizeChannelName,
  parseMentions,
  TeamsStore,
} from './store';

function seeded() {
  const store = new TeamsStore();
  seedStore(store, new Date('2026-11-09T15:00:00Z'));
  return store;
}

describe('seed', () => {
  it('is deterministic', () => {
    const a = seeded();
    const b = seeded();
    expect([...a.channels.keys()]).toEqual([...b.channels.keys()]);
    expect([...a.messages.values()].map((m) => m.body)).toEqual(
      [...b.messages.values()].map((m) => m.body),
    );
    expect(a.stats()).toEqual(b.stats());
    expect(a.stats().notifications_unread).toBe(0);
  });

  it('starts with one team and one General channel', () => {
    const store = seeded();
    expect([...store.teams.keys()]).toEqual(['incident-response']);
    expect([...store.channels.values()].map((c) => c.name)).toEqual(['general']);
  });
});

describe('channels', () => {
  it('normalizes names and derives display names', () => {
    expect(normalizeChannelName('#INC0010234 Customer Profile Errors!')).toBe(
      'inc0010234-customer-profile-errors',
    );
    expect(defaultDisplayName('inc0010234-cif-api-errors')).toBe('INC0010234 CIF API Errors');
  });

  it('notifies each added member with the reason and the other members', () => {
    const store = seeded();
    const { channel } = store.createChannel({
      name: 'inc0010234-customer-profile-errors',
      members: [{ user: 'dwhitfield' }],
    });
    const result = store.addMembers(channel, [
      { user: 'kstreich', reason: 'support for CIF - Customer Information File' },
      { user: 'tom.okafor@keybank.example', reason: 'major incident manager' },
    ]);
    expect(result.added.map((m) => m.username)).toEqual(['kstreich', 'tokafor']);
    const [first] = result.notifications;
    expect(first!.body).toBe(
      "You've been added to #inc0010234-customer-profile-errors as support for CIF - Customer Information File. Here's who else is in the channel: Dana Whitfield (NOC Shift Lead), Tom Okafor (major incident manager).",
    );
    const again = store.addMembers(channel, [{ user: 'kstreich' }]);
    expect(again.added).toHaveLength(0);
    expect(again.notifications).toHaveLength(0);
  });

  it('parses @mentions of known users only', () => {
    expect(parseMentions('@kstreich and @tokafor, ping @nobody-here or mail a@b.com')).toEqual([
      'kstreich',
      'tokafor',
    ]);
  });

  it('rejects unknown users with suggestions', () => {
    const store = seeded();
    const general = store.resolveChannel('incident-response/general');
    expect(() => store.addMembers(general, [{ user: 'dwhitfeld' }])).toThrow(
      /Did you mean: dwhitfield/,
    );
  });
});

describe('renaming a channel', () => {
  const OLD = 'inc0010234-customer-profile-errors';
  const NEW = 'inc0010234-prb0040001-customer-profile-errors';

  function incidentChannel() {
    const store = seeded();
    const { channel } = store.createChannel({
      name: OLD,
      description: 'Customer profile lookups failing.',
      members: [{ user: 'dwhitfield' }, { user: 'kstreich' }],
    });
    return { store, channel };
  }

  it('keeps the id and URL, and the old name keeps resolving', () => {
    const { store, channel } = incidentChannel();
    const before = store.toSummary(channel);
    const unread = store.stats().notifications_unread;
    store.updateChannel(channel, {
      name: `#${NEW.toUpperCase()}`,
      display_name: 'INC0010234 · PRB0040001 Customer profile errors',
    });
    const after = store.toSummary(channel);
    expect(after).toMatchObject({
      id: before.id,
      web_url: before.web_url,
      name: NEW,
      previous_names: [OLD],
      display_name: 'INC0010234 · PRB0040001 Customer profile errors',
      incident_number: 'INC0010234',
    });
    expect(store.resolveChannel(OLD)).toBe(channel);
    expect(store.resolveChannel(`incident-response/${OLD}`)).toBe(channel);
    expect(store.resolveChannel(NEW)).toBe(channel);
    expect(channel.messages.at(-1)).toMatchObject({
      kind: 'system',
      body: 'Incident Automation renamed the channel to INC0010234 · PRB0040001 Customer profile errors.',
    });
    // Renames notify nobody.
    expect(store.stats().notifications_unread).toBe(unread);
  });

  it('re-derives the incident number and a derived display name from the new name', () => {
    const { store, channel } = incidentChannel();
    store.updateChannel(channel, { name: NEW });
    expect(channel.display_name).toBe('INC0010234 PRB0040001 Customer Profile Errors');
    store.updateChannel(channel, { name: 'cif-postmortem' });
    expect(store.toSummary(channel)).toMatchObject({
      name: 'cif-postmortem',
      display_name: 'CIF Postmortem',
      incident_number: null,
      previous_names: [OLD, NEW],
    });
    // Back to a previous name: it stops being an alias.
    store.updateChannel(channel, { name: OLD });
    expect(store.toSummary(channel)).toMatchObject({
      incident_number: 'INC0010234',
      previous_names: [NEW, 'cif-postmortem'],
    });
  });

  it('keeps names unique within the team, previous names included', () => {
    const { store, channel } = incidentChannel();
    const { channel: other } = store.createChannel({ name: 'inc0010300-wire-delays' });
    expect(() => store.updateChannel(other, { name: OLD })).toThrow(/already taken/);
    expect(() => store.updateChannel(other, { name: 'general' })).toThrow(/already taken/);
    store.updateChannel(channel, { name: NEW });
    // The old name still belongs to the renamed channel.
    expect(() => store.updateChannel(other, { name: OLD })).toThrow(
      /since renamed to #inc0010234-prb/,
    );
    expect(() => store.createChannel({ name: OLD })).toThrow(/already exists/);
    expect(other.name).toBe('inc0010300-wire-delays');
  });

  it('updates the description alone, and needs something to change', () => {
    const { store, channel } = incidentChannel();
    store.updateChannel(channel, { description: ' Root cause under PRB0040001. ' });
    expect(channel.description).toBe('Root cause under PRB0040001.');
    expect(channel.messages.at(-1)!.body).toBe(
      'Incident Automation updated the channel description.',
    );
    const count = channel.messages.length;
    store.updateChannel(channel, { name: OLD, description: 'Root cause under PRB0040001.' });
    expect(channel.messages).toHaveLength(count);
    expect(() => store.updateChannel(channel, {})).toThrow(/at least one of/);
    expect(() => store.updateChannel(channel, { name: '!!!' })).toThrow(/letters or digits/);
  });
});

describe('meetings', () => {
  const T0 = new Date('2026-11-09T15:10:00Z');

  function incidentChannel() {
    const store = seeded();
    const { channel } = store.createChannel({
      name: 'inc0010234-customer-profile-errors',
      members: [{ user: 'dwhitfield' }, { user: 'kstreich' }, { user: 'tokafor' }],
    });
    return { store, channel };
  }

  it('starts once, with everything on, and asks the members to join', () => {
    const { store, channel } = incidentChannel();
    expect(store.toSummary(channel).meeting).toBeNull();
    const messages = channel.messages.length;
    const started = store.startMeeting(channel, {}, T0);
    const meeting = store.toSummary(channel).meeting!;
    expect(started.already_running).toBe(false);
    expect(meeting).toMatchObject({
      id: 'mtg_000001',
      title: 'INC0010234 Customer Profile Errors',
      started_at: T0.toISOString(),
      started_by: 'svc_incident_auto',
      started_by_name: 'Incident Automation',
      ended_at: null,
      duration_seconds: null,
      recording: true,
      transcription: true,
      facilitator: true,
      join_url: `${store.channelUrl(channel)}?meeting=mtg_000001`,
    });
    expect(channel.messages).toHaveLength(messages + 1);
    expect(channel.messages.at(-1)).toMatchObject({
      kind: 'system',
      body: `Meeting started: INC0010234 Customer Profile Errors. Recording on · Transcription on · Facilitator taking notes. Join: ${meeting.join_url}`,
    });
    // Everyone but the starter.
    expect(started.notifications.map((n) => n.username)).toEqual([
      'dwhitfield',
      'kstreich',
      'tokafor',
    ]);
    expect(started.notifications[0]).toMatchObject({
      type: 'meeting',
      body: 'Join the call in #inc0010234-customer-profile-errors: INC0010234 Customer Profile Errors',
      message_id: channel.messages.at(-1)!.id,
      read: false,
    });

    const again = store.startMeeting(channel, { title: 'Another call', record: false });
    expect(again.already_running).toBe(true);
    expect(again.meeting).toBe(started.meeting);
    expect(again.notifications).toHaveLength(0);
    expect(channel.messages).toHaveLength(messages + 1);
    expect(store.notificationsFor('kstreich').filter((n) => n.type === 'meeting')).toHaveLength(1);
  });

  it('only mentions the options that are on, and skips the starter', () => {
    const { store, channel } = incidentChannel();
    const started = store.startMeeting(
      channel,
      { title: 'CIF bridge', transcribe: false, facilitator: false, started_by: 'dwhitfield' },
      T0,
    );
    expect(channel.messages.at(-1)!.body).toBe(
      `Meeting started: CIF bridge. Recording on. Join: ${store.channelUrl(channel)}?meeting=mtg_000001`,
    );
    expect(started.notifications.map((n) => n.username)).toEqual([
      'svc_incident_auto',
      'kstreich',
      'tokafor',
    ]);
    store.endMeeting(channel, 'dwhitfield', new Date(T0.getTime() + 90_000));
    expect(channel.messages.at(-1)!.body).toBe(
      'Meeting ended after 2 min. Recording saved to the channel.',
    );
  });

  it('ends with a duration, and a new meeting can start afterwards', () => {
    const { store, channel } = incidentChannel();
    store.startMeeting(channel, {}, T0);
    const ended = store.endMeeting(channel, undefined, new Date(T0.getTime() + 12 * 60_000));
    expect(store.toMeeting(channel, ended)).toMatchObject({
      id: 'mtg_000001',
      ended_at: '2026-11-09T15:22:00.000Z',
      duration_seconds: 720,
    });
    expect(channel.messages.at(-1)).toMatchObject({
      kind: 'system',
      body: 'Meeting ended after 12 min. Recording and transcript saved to the channel.',
    });
    // The ended meeting stays on the channel as the most recent one.
    expect(store.toSummary(channel).meeting).toMatchObject({
      id: 'mtg_000001',
      duration_seconds: 720,
    });

    const next = store.startMeeting(channel, { record: false, transcribe: false });
    expect(next.already_running).toBe(false);
    expect(next.meeting.id).toBe('mtg_000002');
    expect(next.notifications).toHaveLength(3);
  });

  it('refuses to end a meeting that is not in progress', () => {
    const { store, channel } = incidentChannel();
    expect(() => store.endMeeting(channel)).toThrow(/No meeting is in progress/);
    store.startMeeting(channel, {}, T0);
    store.endMeeting(channel, undefined, new Date(T0.getTime() + 30_000));
    expect(() => store.endMeeting(channel)).toThrow(/No meeting is in progress.*mtg_000001/);
    expect(() => store.endMeeting(channel)).toThrowError(expect.objectContaining({ status: 409 }));
  });

  it('formats durations', () => {
    expect(formatDuration(45)).toBe('45 sec');
    expect(formatDuration(720)).toBe('12 min');
    expect(formatDuration(3900)).toBe('1 h 5 min');
    expect(formatDuration(7200)).toBe('2 h');
  });
});
