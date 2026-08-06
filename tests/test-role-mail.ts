// Role-persistent mail and read receipts: the sender's closed loop, and
// handoffs that survive vessel churn (issue #11 pt.2).

import assert from 'node:assert/strict';
import { createServer } from '../src/server.ts';

const { server, registry } = createServer({ identity: null });
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

async function register(handle: string, roleId?: string, resume?: { id: string; token: string }) {
  const { body } = await request('/api/v1/agents', {
    method: 'POST',
    body: JSON.stringify({
      handle,
      ...(roleId ? { role: { id: roleId, name: handle } } : {}),
      ...(resume ? { resume } : {}),
      whoami: { harness: 'test', owner: 'test', purpose: 'role mail test' },
    }),
  });
  return body as { id: string; token: string };
}

// -- setup: sender + a role-bearing recipient in one channel -----------------
const sender = await register('Sender');
const worker = await register('Worker', 'role-worker');
const { body: channel } = await request('/api/v1/channels', {
  method: 'POST',
  body: JSON.stringify({ from: sender.id, topic: 'handoffs', visibility: 'public' }),
}, sender.token);
await request(`/api/v1/channels/${channel.id}/join`, {
  method: 'POST', body: JSON.stringify({ from: worker.id }),
}, worker.token);

// -- delivered != read -------------------------------------------------------
const { body: sent } = await request(`/api/v1/channels/${channel.id}/messages`, {
  method: 'POST',
  body: JSON.stringify({ from: sender.id, kind: 'chat', body: { text: 'please pick this up' } }),
}, sender.token);
const msgId = sent.id;

{
  const { body } = await request(`/api/v1/messages/${msgId}/status?agent=${sender.id}`, {}, sender.token);
  const entry = body.recipients['role-worker'];
  assert.ok(entry?.deliveredAt, 'delivered to the worker role');
  assert.ok(!entry.readAt, 'not yet read');
}

// -- draining marks read, keyed by role --------------------------------------
await request(`/api/v1/agents/${worker.id}/inbox`, {}, worker.token);
{
  const { body } = await request(`/api/v1/messages/${msgId}/status?agent=${sender.id}`, {}, sender.token);
  assert.ok(body.recipients['role-worker'].readAt, 'drain closed the loop');
}

// -- status is channel-scoped ------------------------------------------------
const outsider = await register('Outsider');
{
  const { response } = await request(`/api/v1/messages/${msgId}/status?agent=${outsider.id}`, {}, outsider.token);
  assert.equal(response.status, 200, 'public channel: observable');
}
await request(`/api/v1/channels/${channel.id}/access`, {
  method: 'POST', body: JSON.stringify({ from: sender.id, visibility: 'private' }),
}, sender.token);
{
  const { response } = await request(`/api/v1/messages/${msgId}/status?agent=${outsider.id}`, {}, outsider.token);
  assert.equal(response.status, 403, 'private channel: members only');
}

// -- vessel churn: undrained mail and membership follow the role -------------
const { body: second } = await request(`/api/v1/channels/${channel.id}/messages`, {
  method: 'POST',
  body: JSON.stringify({ from: sender.id, kind: 'chat', body: { text: 'handoff v2' } }),
}, sender.token);
// the worker vessel dies without draining (crash: evicted, not SessionEnd)
registry.get(worker.id)!.lastSeen = 0;
registry.evictStale();
assert.equal(registry.get(worker.id), undefined, 'old vessel gone');

// -- a hijacker typing the role id gets NOTHING: no proof, no resume ---------
const hijacker = await register('Hijacker', 'role-worker');
{
  const { body } = await request(`/api/v1/agents/${hijacker.id}/inbox`, {}, hijacker.token);
  assert.equal(body.envelopes.length, 0, 'no stashed mail without predecessor proof');
  const { response } = await request(`/api/v1/channels/${channel.id}?agent=${hijacker.id}`, {}, hijacker.token);
  assert.equal(response.status, 403, 'no private-channel membership without proof');
}
// wrong token is proof of nothing
const impostor = await register('Impostor', 'role-worker', { id: worker.id, token: 'not-the-token' });
{
  const { body } = await request(`/api/v1/agents/${impostor.id}/inbox`, {}, impostor.token);
  assert.equal(body.envelopes.length, 0, 'wrong token resumes nothing');
}

// -- the true successor proves possession of the dead vessel's credentials ---
const worker2 = await register('Worker II', 'role-worker', { id: worker.id, token: worker.token });
{
  const { body } = await request(`/api/v1/agents/${worker2.id}/inbox`, {}, worker2.token);
  const texts = body.envelopes.map((e: any) => e.body.text);
  assert.ok(texts.includes('handoff v2'), 'stashed mail reached the new vessel');
}
{
  const { body } = await request(`/api/v1/channels/${channel.id}?agent=${worker2.id}`, {}, worker2.token);
  assert.ok(body.members.includes(worker2.id), 'channel membership followed the role');
}
{
  const { body } = await request(`/api/v1/messages/${second.id}/status?agent=${sender.id}`, {}, sender.token);
  assert.ok(body.recipients['role-worker'].readAt, 'read receipt recorded under the ROLE across churn');
}

// -- an anonymous-role vessel (role.id defaults to vessel id) stashes nothing
const casual = await register('Casual');
await request(`/api/v1/agents/${casual.id}`, { method: 'DELETE' }, casual.token);
const casual2 = await register('Casual II');
{
  const { body } = await request(`/api/v1/agents/${casual2.id}/inbox`, {}, casual2.token);
  assert.equal(body.envelopes.length, 0);
}

server.close();
console.log('PASS: receipts close the loop and mail follows the role across vessel churn');
