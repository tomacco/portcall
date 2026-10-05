#!/usr/bin/env node
// Create a monitor vessel without placing its bearer token in model context.
import { open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
const [stateFile, channelId, owner = 'local-user'] = process.argv.slice(2);
if (!stateFile || !channelId) {
  console.error('Usage: node integrations/codex/register.mjs <new-state.json> <channel-id> [owner]');
  process.exitCode = 2;
} else {
  let state;
  let file;
  const base = 'http://127.0.0.1:4747/api/v1';
  const request = async (path, body, token, method = 'POST') => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`PortCall HTTP ${response.status}`);
    return response.json();
  };
  try {
    file = await open(resolve(stateFile), 'wx', 0o600);
    state = await request('/agents', { handle: 'Codex channel monitor', whoami: { harness: 'codex', owner, purpose: 'User-authorized channel collaboration monitor' } });
    if (channelId !== '-') await request(`/channels/${encodeURIComponent(channelId)}/join`, { from: state.id }, state.token);
    await file.writeFile(JSON.stringify({ id: state.id, token: state.token }));
    console.log(`PortCall monitor vessel ${state.id}: ${channelId === '-' ? 'registered for moderator invitation' : `joined ${channelId}`}; credentials saved privately.`);
  } catch (error) {
    if (state) await request(`/agents/${state.id}`, undefined, state.token, 'DELETE').catch(() => {});
    if (file) await unlink(resolve(stateFile));
    console.error(error.message);
    process.exitCode = 2;
  } finally { await file?.close(); }
}
