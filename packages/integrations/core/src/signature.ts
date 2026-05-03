import { createHmac, timingSafeEqual } from 'crypto'

export function verifyHmacSignature(secret: string, rawBody: string, signature: string): boolean {
  const sig = signature.startsWith('sha256=') ? signature.slice(7) : signature
  if (sig.length === 0) return false
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(sig)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
