import { describe, it, expect } from 'vitest';
import { buildInboxChannel, buildConversationChannel, parseChannel } from '../src/channels';

describe('buildInboxChannel', () => {
  it('formats as inbox:{clinicId}', () => {
    expect(buildInboxChannel('38a8a835-007d-472c-8915-eebaea44f3ec')).toBe(
      'inbox:38a8a835-007d-472c-8915-eebaea44f3ec',
    );
  });
});

describe('buildConversationChannel', () => {
  it('formats as conv:{conversationId} (clinicId arg is unused; UUIDs are globally unique)', () => {
    expect(buildConversationChannel('any-clinic', 'conv-1')).toBe('conv:conv-1');
  });

  it('cross-tenant isolation no longer comes from the channel name itself — same conversationId from any caller produces the same channel', () => {
    // The cross-tenant guarantee moved upstream to /api/realtime/token, which
    // pulls conversations via listConversations(clinicId) (RLS-scoped). A user
    // can only subscribe to conv:* channels for conversations in their own
    // clinic because only those channels are in their JWT's channels claim.
    expect(buildConversationChannel('clinic-a', 'conv-x')).toBe(
      buildConversationChannel('clinic-b', 'conv-x'),
    );
  });
});

describe('parseChannel', () => {
  it('parses inbox channel', () => {
    expect(parseChannel('inbox:abc')).toEqual({ type: 'inbox', clinicId: 'abc' });
  });

  it('parses conversation channel', () => {
    expect(parseChannel('conv:xyz')).toEqual({ type: 'conversation', conversationId: 'xyz' });
  });

  it('returns null for malformed channel', () => {
    expect(parseChannel('unknown:abc')).toBeNull();
    expect(parseChannel('clinic:abc:inbox')).toBeNull(); // pre-CHAT-3 alignment format
    expect(parseChannel('inbox:')).toBeNull();
    expect(parseChannel('conv:')).toBeNull();
    expect(parseChannel('')).toBeNull();
  });
});
