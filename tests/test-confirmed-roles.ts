// Confirmed roles: the owner's code ceremony.
// Covers the forgery paths the design must block:
//  - the pending listing and SSE never reveal which code is real
//  - a bad owner key cannot spend (or void) the single code attempt
//  - repeated bad keys lock the ceremony out
//  - a wrong code pick voids the claim (single attempt, Bluetooth-style)
//  - confirmed role names are unique until revoked
//  - confirmation dies with the vessel
//  - a daemon without an owner key refuses the whole ceremony

import assert from 'node:assert/strict';
import { createServer } from '../src/server.ts';

const OWNER_KEY = 'test-owner-key-0123456789abcdef';

const { server, registry } = createServer({ identity: null, ownerKey: OWNER_KEY });
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
  const body = await response.json();
  return { response, body };
}

async function register(handle: string, roleName: string) {
  const { response, body } = await request('/api/v1/agents', {
    method: 'POST',
    body: JSON.stringify({
      handle,
      role: { id: `role-${handle.toLowerCase().replace(/\s+/g, '-')}`, name: roleName },
      whoami: { harness: 'test', owner: 'test', purpose: 'confirmed roles test' },
    }),
  });
  assert.equal(response.status, 201);
  return body as { id: string; token: string };
}

try {
  const head = await register('Captain Bollard', 'Harbor Head');
  const impostor = await register('Sly Bilge Rat', 'Harbor Head');
  const mate = await register('Honest Mate', 'Quartermaster');

  // --- claim: code goes only to the claiming vessel ---
  const claim = await request('/api/v1/roles/confirmations', {
    method: 'POST', body: JSON.stringify({ from: head.id }),
  }, head.token);
  assert.equal(claim.response.status, 201);
  const { confirmationId, code } = claim.body as { confirmationId: string; code: string };
  assert.match(code, /^[BCDFGHJKMNPQRSTVWXZ]{3}-[BCDFGHJKMNPQRSTVWXZ]{3}$/, 'code uses the consonant alphabet');

  // Global SSE announces the claim but never the code or the options.
  const events = await fetch(`${base}/api/v1/events`);
  const reader = events.body!.getReader();
  const replay = new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.ok(replay.includes('role:confirmation-requested'), 'SSE replay announces the pending claim');
  assert.equal(replay.includes(code), false, 'SSE leaked the real code');

  // The public pending listing shows options without marking the real one.
  const pending = await request('/api/v1/roles/confirmations');
  assert.equal(pending.body.pending.length, 1);
  const listed = pending.body.pending[0];
  assert.equal(listed.id, confirmationId);
  assert.equal(listed.codeOptions.length, 6);
  assert.ok(listed.codeOptions.includes(code), 'real code is among the options');
  assert.equal('code' in listed, false, 'pending listing carries no real-code field');

  // --- a second poll returns identical option order (stable, no tells) ---
  const pendingAgain = await request('/api/v1/roles/confirmations');
  assert.deepEqual(pendingAgain.body.pending[0].codeOptions, listed.codeOptions);

  // --- bad owner key: rejected, does not void the claim ---
  const badKey = await request(`/api/v1/roles/confirmations/${confirmationId}/confirm`, {
    method: 'POST', body: JSON.stringify({ code, ownerKey: 'wrong-key' }),
  });
  assert.equal(badKey.response.status, 401);
  const stillPending = await request('/api/v1/roles/confirmations');
  assert.equal(stillPending.body.pending.length, 1, 'bad key must not consume the claim');

  // --- wrong-key hammering gets throttled, but the owner is never locked out ---
  for (let i = 0; i < 4; i++) {
    await request(`/api/v1/roles/confirmations/${confirmationId}/confirm`, {
      method: 'POST', body: JSON.stringify({ code, ownerKey: 'wrong-key' }),
    });
  }
  const throttled = await request(`/api/v1/roles/confirmations/${confirmationId}/confirm`, {
    method: 'POST', body: JSON.stringify({ code, ownerKey: 'wrong-key' }),
  });
  assert.equal(throttled.response.status, 429, 'sustained wrong keys are throttled');

  // --- right key + right code: confirmed, even mid-throttle (no DoS on the owner) ---
  const confirmed = await request(`/api/v1/roles/confirmations/${confirmationId}/confirm`, {
    method: 'POST', body: JSON.stringify({ code, ownerKey: OWNER_KEY }),
  });
  assert.equal(confirmed.response.status, 200, 'the correct key works during wrong-key throttle');
  assert.equal(confirmed.body.agent.role.confirmed, true);

  const roster = await request('/api/v1/agents');
  const rosterHead = roster.body.agents.find((agent: any) => agent.id === head.id);
  const rosterImpostor = roster.body.agents.find((agent: any) => agent.id === impostor.id);
  assert.equal(rosterHead.role.confirmed, true);
  assert.equal(rosterImpostor.role.confirmed, false, 'a self-asserted claim stays unconfirmed');

  // --- messages carry the confirmed flag ---
  const channel = await request('/api/v1/channels', {
    method: 'POST', body: JSON.stringify({ from: head.id, topic: 'Harbor orders', visibility: 'public' }),
  }, head.token);
  await request(`/api/v1/channels/${channel.body.id}/messages`, {
    method: 'POST', body: JSON.stringify({ from: head.id, kind: 'chat', body: { text: 'Pennant up.' } }),
  }, head.token);
  const messages = await request('/api/v1/messages');
  const last = messages.body.messages.at(-1);
  assert.equal(last.from.role.confirmed, true, 'envelope role carries confirmation');

  // --- uniqueness: the impostor cannot even open a claim on a confirmed name ---
  const dupe = await request('/api/v1/roles/confirmations', {
    method: 'POST', body: JSON.stringify({ from: impostor.id }),
  }, impostor.token);
  assert.equal(dupe.response.status, 409, 'confirmed role names are unique');

  // --- wrong code pick voids the claim entirely ---
  const mateClaim = await request('/api/v1/roles/confirmations', {
    method: 'POST', body: JSON.stringify({ from: mate.id }),
  }, mate.token);
  const mateListing = (await request('/api/v1/roles/confirmations')).body.pending
    .find((entry: any) => entry.vessel.id === mate.id);
  const decoy = mateListing.codeOptions.find((option: string) => option !== mateClaim.body.code);
  const voided = await request(`/api/v1/roles/confirmations/${mateClaim.body.confirmationId}/confirm`, {
    method: 'POST', body: JSON.stringify({ code: decoy, ownerKey: OWNER_KEY }),
  });
  assert.equal(voided.response.status, 409);
  const afterVoid = await request('/api/v1/roles/confirmations');
  assert.equal(afterVoid.body.pending.some((entry: any) => entry.vessel.id === mate.id), false, 'wrong pick voided the claim');
  const retryVoided = await request(`/api/v1/roles/confirmations/${mateClaim.body.confirmationId}/confirm`, {
    method: 'POST', body: JSON.stringify({ code: mateClaim.body.code, ownerKey: OWNER_KEY }),
  });
  assert.equal(retryVoided.response.status, 410, 'a voided claim cannot be revived');

  // --- a voided claim puts the role name on cooldown (no brute-force re-rolls) ---
  const cooled = await request('/api/v1/roles/confirmations', {
    method: 'POST', body: JSON.stringify({ from: mate.id }),
  }, mate.token);
  assert.equal(cooled.response.status, 429, 'voided claim triggers a re-request cooldown');
  (registry as any).voidedClaimCooldowns.clear();

  // --- expiry ---
  const mateClaim2 = await request('/api/v1/roles/confirmations', {
    method: 'POST', body: JSON.stringify({ from: mate.id }),
  }, mate.token);
  const pendingMap = (registry as any).confirmations as Map<string, { expiresAt: number }>;
  pendingMap.get(mateClaim2.body.confirmationId)!.expiresAt = Date.now() - 1;
  const expired = await request(`/api/v1/roles/confirmations/${mateClaim2.body.confirmationId}/confirm`, {
    method: 'POST', body: JSON.stringify({ code: mateClaim2.body.code, ownerKey: OWNER_KEY }),
  });
  assert.equal(expired.response.status, 410, 'expired claims are gone');

  // --- revocation frees the name; confirmation dies with the vessel ---
  const revoked = await request('/api/v1/roles/revoke', {
    method: 'POST', body: JSON.stringify({ vesselId: head.id, ownerKey: OWNER_KEY }),
  });
  assert.equal(revoked.response.status, 200);
  assert.equal(revoked.body.agent.role.confirmed, false);

  const impostorRetry = await request('/api/v1/roles/confirmations', {
    method: 'POST', body: JSON.stringify({ from: impostor.id }),
  }, impostor.token);
  assert.equal(impostorRetry.response.status, 201, 'a revoked name may be claimed again');
  const reconfirm = await request(`/api/v1/roles/confirmations/${impostorRetry.body.confirmationId}/confirm`, {
    method: 'POST', body: JSON.stringify({ code: impostorRetry.body.code, ownerKey: OWNER_KEY }),
  });
  assert.equal(reconfirm.response.status, 200);
  await request(`/api/v1/agents/${impostor.id}`, { method: 'DELETE' }, impostor.token);
  const rosterAfterLeave = await request('/api/v1/agents');
  assert.equal(rosterAfterLeave.body.agents.some((agent: any) => agent.id === impostor.id), false);
  const freshHead = await register('Returning Head', 'Harbor Head');
  const freshClaim = await request('/api/v1/roles/confirmations', {
    method: 'POST', body: JSON.stringify({ from: freshHead.id }),
  }, freshHead.token);
  assert.equal(freshClaim.response.status, 201, 'confirmation died with the departed vessel');

  // --- a keyless daemon refuses the ceremony entirely ---
  const keyless = createServer({ identity: null });
  await new Promise<void>((resolve, reject) => {
    keyless.server.once('error', reject);
    keyless.server.listen(0, '127.0.0.1', resolve);
  });
  const keylessAddress = keyless.server.address();
  if (!keylessAddress || typeof keylessAddress === 'string') throw new Error('No keyless address');
  const keylessBase = `http://127.0.0.1:${keylessAddress.port}`;
  const keylessAgent = await (await fetch(`${keylessBase}/api/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle: 'Keyless', role: { name: 'Harbor Head' }, whoami: { harness: 'test', owner: 'test', purpose: 'keyless test' } }),
  })).json();
  const keylessClaim = await fetch(`${keylessBase}/api/v1/roles/confirmations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${keylessAgent.token}` },
    body: JSON.stringify({ from: keylessAgent.id }),
  });
  assert.equal(keylessClaim.status, 503, 'no owner key, no ceremony');
  const keylessStatus = await (await fetch(`${keylessBase}/api/v1/status`)).json();
  assert.equal(keylessStatus.roleConfirmations, 'disabled');
  keyless.server.close();

  console.log('confirmed-roles: all assertions passed');
} finally {
  server.close();
}
