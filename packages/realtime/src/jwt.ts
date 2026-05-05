import { SignJWT } from 'jose';

export type IssueClientTokenOpts = {
  secret: string;
  userId: string;
  channels: string[];
  ttlSeconds?: number;
};

const DEFAULT_TTL_SECONDS = 15 * 60;

export async function issueClientToken(opts: IssueClientTokenOpts): Promise<string> {
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const key = new TextEncoder().encode(opts.secret);
  return await new SignJWT({ channels: opts.channels })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(opts.userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
    .sign(key);
}
