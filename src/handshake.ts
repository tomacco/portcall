// The Flag Check: a zero-knowledge-style proof that two agents sail under
// the same owner. Both sides hold the same "anchor" secret (fetched
// independently from the owner's GitHub/GitLab — see src/identity/). The
// secret itself never crosses the wire; each side only proves possession
// via HMAC over fresh nonces.
//
//   A -> B  hs/hello      { n: nA }
//   B -> A  hs/challenge  { n: nB, mac: MAC(K, nA, nB, idB) }
//   A -> B  hs/proof      { mac: MAC(K, nB, nA, idA) }
//
// Both then derive a session key with HKDF and report a transcript hash to
// the daemon; the pair is marked verified only when both hashes match.
//
// Honest print: this is proof-of-possession of a shared secret, in the
// zero-knowledge *style* (nothing about K leaks), not a formal ZKP circuit.

import crypto from 'node:crypto';

export const HS_VERSION = 'portcall-hs-v1';

// key = UTF-8 bytes of the anchor string; data = UTF-8 concat of version + parts.
// Kept dead simple on purpose so non-Node clients (see PortCall.psm1) match it.
export function mac(anchor: string, ...parts: string[]): string {
  const h = crypto.createHmac('sha256', anchor);
  h.update(HS_VERSION);
  for (const p of parts) h.update(String(p));
  return h.digest('hex');
}

export function safeEqual(aHex: string, bHex: string): boolean {
  try {
    const a = Buffer.from(aHex, 'hex');
    const b = Buffer.from(bHex, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function nonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function sessionKey(anchor: string, nA: string, nB: string): string {
  const salt = Buffer.from(nA + nB, 'utf8');
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(anchor, 'utf8'), salt, 'portcall-session-v1', 32),
  ).toString('hex');
}

export function transcriptHash(nA: string, nB: string, idA: string, idB: string): string {
  return crypto
    .createHash('sha256')
    .update([HS_VERSION, nA, nB, idA, idB].join('|'))
    .digest('hex');
}
