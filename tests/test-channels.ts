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

async function register(handle: string, role?: { id: string; name: string; charter?: string; contextRef?: string }) {
  const { response, body } = await request('/api/v1/agents', {
    method: 'POST',
    body: JSON.stringify({ handle, role, whoami: { harness: 'test', model: 'test-actor', owner: 'test', purpose: 'channel test' } }),
  });
  assert.equal(response.status, 201);
  return body as { id: string; token: string; agent: { role: { id: string; name: string }; actor: { model?: string }; vessel: { id: string } } };
}

try {
  const captain = await register('Captain Context', {
    id: 'role-navigator', name: 'The Navigator', charter: 'Keep shared context coherent.',
    contextRef: 'distill://portcall/personas/navigator',
  });
  assert.equal(captain.agent.role.id, 'role-navigator');
  assert.equal(captain.agent.vessel.id, captain.id);
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
  assert.equal(mateInbox.body.envelopes[0].from.role.id, 'role-navigator');
  assert.equal(mateInbox.body.envelopes[0].from.vessel.id, captain.id);
  assert.equal(mateInbox.body.envelopes[0].from.actor.model, 'test-actor');
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

  const unauthenticatedA2A = await request(`/a2a/${mate.id}`, {
    method: 'POST', body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'message/send',
      params: { message: { parts: [{ kind: 'data', data: { channelId: publicChannel.body.id } }] } },
    }),
  });
  assert.equal(unauthenticatedA2A.response.status, 401, 'A2A publishing requires the URL agent bearer token');

  const authenticatedA2A = await request(`/a2a/${mate.id}`, {
    method: 'POST', body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'message/send',
      params: { message: { parts: [{ kind: 'data', data: { portcallEnvelope: {
        from: { id: outsider.id, handle: 'Spoofed' }, channelId: publicChannel.body.id,
        kind: 'chat', body: { text: 'normalized identity' },
      } } }] } },
    }),
  }, mate.token);
  assert.equal(authenticatedA2A.response.status, 200);
  const normalizedInbox = await request(`/api/v1/agents/${outsider.id}/inbox`, {}, outsider.token);
  assert.equal(normalizedInbox.body.envelopes[0].from.id, mate.id, 'A2A envelope identity comes from bearer auth');

  const noChannelHandshake = await request('/api/v1/handshakes/confirm', {
    method: 'POST', body: JSON.stringify({ from: captain.id, peerId: mate.id, transcript: 'same' }),
  }, captain.token);
  assert.equal(noChannelHandshake.response.status, 404);
  const firstReport = await request('/api/v1/handshakes/confirm', {
    method: 'POST', body: JSON.stringify({ from: captain.id, channelId: channel.id, peerId: mate.id, transcript: 'same' }),
  }, captain.token);
  assert.equal(firstReport.body.matched, false);
  const secondReport = await request('/api/v1/handshakes/confirm', {
    method: 'POST', body: JSON.stringify({ from: mate.id, channelId: channel.id, peerId: captain.id, transcript: 'same' }),
  }, mate.token);
  assert.equal(secondReport.body.matched, true);
  const anonymousRoster = await request('/api/v1/agents');
  const publicCaptain = anonymousRoster.body.agents.find((agent: { id: string }) => agent.id === captain.id);
  assert.equal(publicCaptain.anchorMatchesWith.includes(mate.id), false, 'private Flag Check relationship leaked publicly');
  const privateRoster = await request(`/api/v1/agents?agent=${captain.id}`, {}, captain.token);
  const memberCaptain = privateRoster.body.agents.find((agent: { id: string }) => agent.id === captain.id);
  assert.equal(memberCaptain.anchorMatchesWith.includes(mate.id), true);
  const excludedPeer = await request('/api/v1/handshakes/confirm', {
    method: 'POST', body: JSON.stringify({ from: outsider.id, channelId: channel.id, peerId: captain.id, transcript: 'same' }),
  }, outsider.token);
  assert.equal(excludedPeer.response.status, 403);

  const broken = await request('/api/v1/agents', {
    method: 'POST', body: JSON.stringify({
      handle: 'Broken A2A', whoami: { harness: 'test', owner: 'test', purpose: 'delivery failure' },
      protocols: { a2a: { endpoint: 'http://127.0.0.1:1' } },
    }),
  });
  await request(`/api/v1/channels/${channel.id}/members`, {
    method: 'POST', body: JSON.stringify({ from: captain.id, agentId: broken.body.id }),
  }, captain.token);
  const partial = await request(`/api/v1/channels/${channel.id}/messages`, {
    method: 'POST', body: JSON.stringify({ from: captain.id, kind: 'chat', body: { text: 'survives one broken transport' } }),
  }, captain.token);
  assert.equal(partial.response.status, 202);
  assert.equal(partial.body.deliveries.some((delivery: { ok: boolean }) => !delivery.ok), true);
  const durableFeed = await request(`/api/v1/messages?agent=${captain.id}`, {}, captain.token);
  assert.equal(durableFeed.body.messages.at(-1).body.text, 'survives one broken transport');

  const stream = await fetch(`${base}/api/v1/agents/${outsider.id}/stream?token=${outsider.token}`);
  const reader = stream.body!.getReader();
  await reader.read();
  await request(`/api/v1/agents/${outsider.id}`, { method: 'DELETE' }, outsider.token);
  const closed = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stream did not close on leave')), 1000)),
  ]);
  assert.equal(closed.done, true);

  const visible = await request(`/api/v1/channels?agent=${mate.id}`, {}, mate.token);
  assert.equal(visible.body.channels.length, 2, 'agents can participate in multiple channels');
  console.log('PASS: conversations are channel-bound with enforced admission');
} finally {
  server.close();
}
