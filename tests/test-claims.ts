// Claims: soft advisory "I am working on this" declarations. Ownership,
// overlap matching across the Windows/WSL divide, TTL expiry, and release
// with the holder.

import assert from 'node:assert/strict';
import { createServer } from '../src/server.ts';
import { normalizeClaimPath, overlaps } from '../src/registry.ts';

const { server } = createServer({ identity: null });
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('No test server address');
const base = `http://127.0.0.1:${address.port}`;

async function request(path: string, init: RequestInit = {}, token?: string) {
  const response = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  return { response, body: await response.json() };
}

async function register(handle: string) {
  const { body } = await request('/api/v1/agents', {
    method: 'POST',
    body: JSON.stringify({ handle, whoami: { harness: 'test', owner: 'test', purpose: 'claims test' } }),
  });
  return body as { id: string; token: string };
}

// -- path normalization and overlap (pure) -----------------------------------
assert.equal(normalizeClaimPath('C:\\Users\\Ivan\\repo\\'), 'c:/users/ivan/repo');
assert.equal(normalizeClaimPath('/mnt/c/Users/Ivan/repo'), 'c:/users/ivan/repo');
assert.ok(overlaps('c:/users/ivan/repo', 'c:/users/ivan/repo/src/file.ts'));
assert.ok(overlaps('c:/users/ivan/repo/src/file.ts', 'c:/users/ivan/repo'));
assert.ok(!overlaps('c:/users/ivan/repo', 'c:/users/ivan/repo-two'), 'segment boundary respected');
assert.ok(!overlaps('c:/a/b', 'c:/a/c'));

const alice = await register('Alice');
const bob = await register('Bob');

// -- create requires auth and a path -----------------------------------------
{
  const { response } = await request('/api/v1/claims', {
    method: 'POST',
    body: JSON.stringify({ from: alice.id, path: '/home/ivan/deck' }),
  }, 'wrong-token');
  assert.equal(response.status, 401);
}
{
  const { response } = await request('/api/v1/claims', {
    method: 'POST',
    body: JSON.stringify({ from: alice.id, note: 'no path' }),
  }, alice.token);
  assert.equal(response.status, 422);
}

// -- claim, list, cross-divide overlap ---------------------------------------
const { body: claim } = await request('/api/v1/claims', {
  method: 'POST',
  body: JSON.stringify({ from: alice.id, path: '/mnt/c/Users/Ivan/workshop/deck', note: 'restyling slides', ttlSec: 600 }),
}, alice.token);
assert.match(claim.id, /^cl_/);
assert.equal(claim.holder.handle, 'Alice');

{
  const { body } = await request('/api/v1/claims?touches=' + encodeURIComponent('C:\\Users\\Ivan\\workshop\\deck\\index.html'));
  assert.equal(body.claims.length, 1, 'windows spelling of a WSL claim matches');
  assert.equal(body.claims[0].id, claim.id);
}
{
  const { body } = await request('/api/v1/claims?touches=' + encodeURIComponent('/mnt/c/Users/Ivan/other'));
  assert.equal(body.claims.length, 0, 'non-overlapping path filtered out');
}

// -- re-claim refreshes, does not duplicate ----------------------------------
const { body: again } = await request('/api/v1/claims', {
  method: 'POST',
  body: JSON.stringify({ from: alice.id, path: '/mnt/c/Users/Ivan/workshop/deck', note: 'still at it', ttlSec: 600 }),
}, alice.token);
assert.equal(again.id, claim.id, 'same path refreshes the same claim');
{
  const { body } = await request('/api/v1/claims');
  assert.equal(body.claims.length, 1);
  assert.equal(body.claims[0].note, 'still at it');
}

// -- only the holder can release ---------------------------------------------
{
  const { response } = await request(`/api/v1/claims/${claim.id}`, {
    method: 'DELETE',
    body: JSON.stringify({ from: bob.id }),
  }, bob.token);
  assert.equal(response.status, 403);
}
{
  const { response } = await request(`/api/v1/claims/${claim.id}`, {
    method: 'DELETE',
    body: JSON.stringify({ from: alice.id }),
  }, alice.token);
  assert.equal(response.status, 200);
  const { body } = await request('/api/v1/claims');
  assert.equal(body.claims.length, 0);
}

// -- TTL expiry (minimum is clamped to 60s, so backdate via a fresh claim) ---
const { body: dying } = await request('/api/v1/claims', {
  method: 'POST',
  body: JSON.stringify({ from: bob.id, path: '/tmp/expiring', ttlSec: 60 }),
}, bob.token);
assert.ok(dying.expiresAt - Date.now() <= 61_000, 'ttl clamped to the 60s floor');
assert.ok(dying.expiresAt - Date.now() > 30_000);

// -- claims vanish with their holder -----------------------------------------
await request('/api/v1/claims', {
  method: 'POST',
  body: JSON.stringify({ from: bob.id, path: '/tmp/bobs-tree', ttlSec: 600 }),
}, bob.token);
await request(`/api/v1/agents/${bob.id}`, { method: 'DELETE' }, bob.token);
{
  const { body } = await request('/api/v1/claims');
  assert.equal(body.claims.length, 0, 'leaving released every claim Bob held');
}

server.close();
console.log('PASS: claims are advisory, holder-owned, TTL-bounded, and cross the OS divide');
