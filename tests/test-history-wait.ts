import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../src/server.ts';

// Channel history for late joiners, and the long-poll inbox (?wait=N) that lets a busy or
// waiting harness block until the next envelope without a second consuming path.

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
  const { response, body } = await request('/api/v1/agents', {
    method: 'POST',
    body: JSON.stringify({ handle, whoami: { harness: 'test', model: 'test-actor', owner: 'test', purpose: 'history test' } }),
  });
  assert.equal(response.status, 201);
  return body as { id: string; token: string };
}

async function say(agent: { id: string; token: string }, channelId: string, text: string) {
  const { response, body } = await request(`/api/v1/channels/${channelId}/messages`, {
    method: 'POST', body: JSON.stringify({ from: agent.id, kind: 'chat', body: { text } }),
  }, agent.token);
  assert.equal(response.status, 202);
  return body.id as string;
}

async function channel(owner: { id: string; token: string }, visibility: string) {
  const { body } = await request('/api/v1/channels', {
    method: 'POST', body: JSON.stringify({ from: owner.id, topic: `history ${visibility}`, visibility }),
  }, owner.token);
  return body.id as string;
}

const texts = (messages: { body: { text: string } }[]) => messages.map((m) => m.body.text);

try {
  const lead = await register('Lead');
  const late = await register('Late Joiner');
  const outsider = await register('Outsider');

  // --- history: a late joiner reads what was said before it arrived
  const pub = await channel(lead, 'public');
  const first = await say(lead, pub, 'mission');
  await say(lead, pub, 'proposal');
  await request(`/api/v1/channels/${pub}/join`, { method: 'POST', body: JSON.stringify({ from: late.id }) }, late.token);
  let history = await request(`/api/v1/channels/${pub}/messages?agent=${late.id}`, {}, late.token);
  assert.equal(history.response.status, 200);
  assert.deepEqual(texts(history.body.messages), ['mission', 'proposal'], 'late joiner sees earlier messages');
  history = await request(`/api/v1/channels/${pub}/messages?agent=${late.id}&since=${first}`, {}, late.token);
  assert.deepEqual(texts(history.body.messages), ['proposal'], 'since=<message id> is exclusive');
  history = await request(`/api/v1/channels/${pub}/messages?agent=${late.id}&n=1`, {}, late.token);
  assert.deepEqual(texts(history.body.messages), ['proposal'], 'without since, n keeps the most recent');
  assert.equal(history.body.more, true, 'more flags the older message left out');
  await say(lead, pub, 'third');
  history = await request(`/api/v1/channels/${pub}/messages?agent=${late.id}&since=${first}&n=1`, {}, late.token);
  assert.deepEqual(texts(history.body.messages), ['proposal'], 'with since, n pages forward: the next message, not the newest');
  assert.equal(history.body.more, true, 'more says the page stopped early');
  history = await request(`/api/v1/channels/${pub}/messages?agent=${late.id}&since=${first}&n=5`, {}, late.token);
  assert.deepEqual(texts(history.body.messages), ['proposal', 'third']);
  assert.equal(history.body.more, false, 'a complete page has more=false');
  history = await request(`/api/v1/channels/${pub}/messages?agent=${late.id}&since=msg_nope`, {}, late.token);
  assert.equal(history.response.status, 404, 'an unknown since id is an explicit error, not an empty page');

  // --- history: private channels stay private
  const priv = await channel(lead, 'private');
  await say(lead, priv, 'secret');
  history = await request(`/api/v1/channels/${priv}/messages?agent=${outsider.id}`, {}, outsider.token);
  assert.equal(history.response.status, 403, 'non-member cannot read private history');
  history = await request(`/api/v1/channels/${priv}/messages`);
  assert.equal(history.response.status, 403, 'anonymous viewer cannot read private history');
  history = await request(`/api/v1/channels/${priv}/messages?agent=${lead.id}`, {}, lead.token);
  assert.deepEqual(texts(history.body.messages), ['secret'], 'member reads private history');
  history = await request(`/api/v1/channels/${priv}/messages?agent=${lead.id}`, {}, outsider.token);
  assert.equal(history.response.status, 401, 'a token must match the claimed viewer');

  // --- long-poll: returns immediately when something is queued
  await request(`/api/v1/agents/${late.id}/inbox`, {}, late.token); // drain the join-time traffic
  await say(lead, pub, 'queued');
  let t0 = Date.now();
  let polled = await request(`/api/v1/agents/${late.id}/inbox?wait=10`, {}, late.token);
  assert.deepEqual(texts(polled.body.envelopes), ['queued']);
  assert.ok(Date.now() - t0 < 1000, 'a non-empty inbox answers at once');

  // --- long-poll: blocks until the next envelope, then delivers it exactly once
  t0 = Date.now();
  const pending = request(`/api/v1/agents/${late.id}/inbox?wait=10`, {}, late.token);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await say(lead, pub, 'pushed');
  polled = await pending;
  assert.deepEqual(texts(polled.body.envelopes), ['pushed'], 'the waiter receives the new envelope');
  assert.ok(Date.now() - t0 >= 300 && Date.now() - t0 < 3000, 'it woke on arrival, not on timeout');
  const after = await request(`/api/v1/agents/${late.id}/inbox`, {}, late.token);
  assert.deepEqual(after.body.envelopes, [], 'the inbox stays the single consuming path: no duplicate');

  // --- long-poll: times out with an empty list
  t0 = Date.now();
  polled = await request(`/api/v1/agents/${late.id}/inbox?wait=1`, {}, late.token);
  assert.deepEqual(polled.body.envelopes, []);
  assert.ok(Date.now() - t0 >= 900, 'wait=1 holds about a second');

  // --- long-poll: a client that disconnects never loses a message
  await new Promise<void>((resolve) => {
    const req = http.get(`${base}/api/v1/agents/${late.id}/inbox?wait=10`, { headers: { authorization: `Bearer ${late.token}` } });
    req.on('error', () => resolve());
    setTimeout(() => { req.destroy(); resolve(); }, 200);
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await say(lead, pub, 'after-disconnect');
  const kept = await request(`/api/v1/agents/${late.id}/inbox`, {}, late.token);
  assert.deepEqual(texts(kept.body.envelopes), ['after-disconnect'], 'a dropped waiter does not swallow the next envelope');


  // --- long-poll: auth still applies
  polled = await request(`/api/v1/agents/${late.id}/inbox?wait=1`, {}, outsider.token);
  assert.equal(polled.response.status, 401);

  console.log('history + wait: all checks passed');
} finally {
  server.closeAllConnections();
  server.close();
}
