import { describe, it, expect } from 'vitest';
import { jwtVerify } from 'jose';
import { issueClientToken } from '../src/jwt';

const SECRET = 'test-secret-32-bytes-long-xxxxxxxx';
const KEY = new TextEncoder().encode(SECRET);

describe('issueClientToken', () => {
  it('produces a JWT verifiable with the same HMAC secret', async () => {
    const token = await issueClientToken({
      secret: SECRET,
      userId: 'user-1',
      channels: ['clinic:c1:inbox'],
    });
    const { payload } = await jwtVerify(token, KEY);
    expect(payload.sub).toBe('user-1');
  });

  it('exp is 15 minutes from now (±5s tolerance)', async () => {
    const token = await issueClientToken({ secret: SECRET, userId: 'u', channels: [] });
    const { payload } = await jwtVerify(token, KEY);
    const expected = Math.floor(Date.now() / 1000) + 15 * 60;
    expect(payload.exp).toBeGreaterThanOrEqual(expected - 5);
    expect(payload.exp).toBeLessThanOrEqual(expected + 5);
  });

  it('channels claim is included verbatim', async () => {
    const channels = ['clinic:c1:inbox', 'clinic:c1:conv:x', 'clinic:c1:conv:y'];
    const token = await issueClientToken({ secret: SECRET, userId: 'u', channels });
    const { payload } = await jwtVerify(token, KEY);
    expect(payload['channels']).toEqual(channels);
  });

  it('different users produce JWTs with different sub claims', async () => {
    const a = await issueClientToken({ secret: SECRET, userId: 'user-a', channels: [] });
    const b = await issueClientToken({ secret: SECRET, userId: 'user-b', channels: [] });
    const pa = (await jwtVerify(a, KEY)).payload;
    const pb = (await jwtVerify(b, KEY)).payload;
    expect(pa.sub).toBe('user-a');
    expect(pb.sub).toBe('user-b');
  });
});
