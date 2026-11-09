import { describe, expect, it } from 'vitest';
import { seedStore } from './seed';
import { defaultDisplayName, normalizeChannelName, parseMentions, TeamsStore } from './store';

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
