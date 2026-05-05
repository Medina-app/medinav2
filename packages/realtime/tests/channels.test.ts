import { describe, it, expect } from 'vitest';
import { buildInboxChannel, buildConversationChannel, parseChannel } from '../src/channels';

describe('buildInboxChannel', () => {
  it('formats as clinic:{id}:inbox', () => {
    expect(buildInboxChannel('38a8a835-007d-472c-8915-eebaea44f3ec')).toBe(
      'clinic:38a8a835-007d-472c-8915-eebaea44f3ec:inbox',
    );
  });
});

describe('buildConversationChannel', () => {
  it('formats as clinic:{id}:conv:{convId}', () => {
    expect(buildConversationChannel('clinic-a', 'conv-1')).toBe('clinic:clinic-a:conv:conv-1');
  });

  it('different clinics produce non-overlapping channels (cross-tenant isolation)', () => {
    expect(buildConversationChannel('clinic-a', 'conv-x')).not.toBe(
      buildConversationChannel('clinic-b', 'conv-x'),
    );
  });
});

describe('parseChannel', () => {
  it('parses inbox channel', () => {
    expect(parseChannel('clinic:abc:inbox')).toEqual({ type: 'inbox', clinicId: 'abc' });
  });

  it('parses conversation channel', () => {
    expect(parseChannel('clinic:abc:conv:xyz')).toEqual({
      type: 'conversation',
      clinicId: 'abc',
      conversationId: 'xyz',
    });
  });

  it('returns null for malformed channel', () => {
    expect(parseChannel('user:abc')).toBeNull();
    expect(parseChannel('clinic:abc')).toBeNull();
    expect(parseChannel('')).toBeNull();
    expect(parseChannel('clinic::inbox')).toBeNull();
    expect(parseChannel('clinic:abc:conv:')).toBeNull();
  });
});
