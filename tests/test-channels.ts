import assert from 'node:assert/strict';
import { createServer } from '../src/server.ts';

const { server } = createServer({ identity: null });
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
await new Promise((resolve) => setTimeout(resolve, 50));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('No test server address');
const base = `http://127.0.0.1:${address.port}`;

async function request(path: string, init: RequestInit = {}, token?: string) {
  const response = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  const body = await response.json();
  return { response, body };
}

async function register(handle: string) {
  const { response, body } = await request('/api/v1/agents', {
    method: 'POST',
    body: JSON.stringify({ handle, whoami: { harness: 'test', owner: 'test', purpose: 'channel test' } }),
  });
  assert.equal(response.status, 201);
  return body as { id: string; token: string };
}

try {
  const captain = await register('Captain Context');
  const mate = await register('Mate Bubble');
  const outsider = await register('Outsider Direct Message');

  const created = await request('/api/v1/channels', {
    method: 'POST', body: JSON.stringify({ from: captain.id, topic: 'Installer safety', visibility: 'private' }),
  }, captain.token);
  assert.equal(created.response.status, 201);
  const channel = created.body as { id: string; members: string[] };
  assert.deepEqual(channel.members, [captain.id]);

  const blocked = await request(`/api/v1/channels/${channel.id}/join`, {
    method: 'POST', body: JSON.stringify({ from: mate.id }),
  }, mate.token);
  assert.equal(blocked.response.status, 403);

  const invited = await request(`/api/v1/channels/${channel.id}/members`, {
    method: 'POST', body: JSON.stringify({ from: captain.id, agentId: mate.id }),
  }, captain.token);
  assert.equal(invited.response.status, 200);

  const published = await request(`/api/v1/channels/${channel.id}/messages`, {
    method: 'POST', body: JSON.stringify({ from: captain.id, kind: 'chat', body: { text: 'Buffered writes only.' } }),
  }, captain.token);
  assert.equal(published.response.status, 202);

  const mateInbox = await request(`/api/v1/agents/${mate.id}/inbox`, {}, mate.token);
  assert.equal(mateInbox.body.envelopes.length, 1);
  assert.equal(mateInbox.body.envelopes[0].channelId, channel.id);
  const outsiderInbox = await request(`/api/v1/agents/${outsider.id}/inbox`, {}, outsider.token);
  assert.equal(outsiderInbox.body.envelopes.length, 0);

  const publicFeed = await request('/api/v1/messages');
  assert.equal(publicFeed.body.messages.length, 0, 'private channel traffic must not leak to the public Glass');
  const memberFeed = await request(`/api/v1/messages?agent=${mate.id}`, {}, mate.token);
  assert.equal(memberFeed.body.messages.length, 1);

  const direct = await request('/api/v1/messages', {
    method: 'POST', body: JSON.stringify({ from: captain.id, to: mate.id, body: { text: 'forbidden' } }),
  }, captain.token);
  assert.equal(direct.response.status, 410);

  const publicChannel = await request('/api/v1/channels', {
    method: 'POST', body: JSON.stringify({ from: mate.id, topic: 'Open deck', visibility: 'public' }),
  }, mate.token);
  const joined = await request(`/api/v1/channels/${publicChannel.body.id}/join`, {
    method: 'POST', body: JSON.stringify({ from: outsider.id }),
  }, outsider.token);
  assert.equal(joined.response.status, 200);

  const visible = await request(`/api/v1/channels?agent=${mate.id}`, {}, mate.token);
  assert.equal(visible.body.channels.length, 2, 'agents can participate in multiple channels');
  const outsiderView = await request(`/api/v1/channels?agent=${outsider.id}`, {}, outsider.token);
  assert.equal(outsiderView.body.channels.some((candidate: { id: string }) => candidate.id === channel.id), false);
  console.log('PASS: conversations are channel-bound with enforced admission');
} finally {
  server.close();
}
