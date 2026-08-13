#!/usr/bin/env node
// The harbor master. Start it, point your agents (and the UI) at it.
//
//   node src/daemon.ts [--port 4747] [--host 127.0.0.1] [--identity github|gitlab|none]
//
// The daemon never touches the anchor secret; --identity only controls which
// provider it *reports* so clients know where to fetch their own anchor.

import crypto from 'node:crypto';
import { createServer } from './server.ts';
import { getProvider } from './identity/index.ts';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = Number(arg('port', process.env.PORTCALL_PORT ?? '4747'));
const host = arg('host', '127.0.0.1');
const identityName = arg('identity', process.env.PORTCALL_IDENTITY ?? 'github');

// Owner key for confirming role claims (Jupyter-token pattern). Printed ONLY
// on an interactive start: a hook-launched daemon redirects stdout into an
// agent-readable daemon.log, and the key must never land where agents
// routinely read. Headless daemons need PORTCALL_OWNER_KEY, or run with
// confirmations disabled.
const ownerKey = process.env.PORTCALL_OWNER_KEY
  ?? (process.stdout.isTTY ? crypto.randomBytes(16).toString('hex') : null);

const { server, state } = createServer({
  identity: identityName === 'none' ? null : identityName,
  ownerKey,
});

server.listen(port, host, async () => {
  console.log(`
  ⚓ portcall — the harbor is open
     http://${host}:${port}       (UI + API)
     http://${host}:${port}/a2a/<agent-id>   (A2A gateway)
     identity provider: ${state.identity ?? 'none (handshakes disabled by choice)'}
     persistent roles, changing vessels — with provenance always aboard.
     no anonymous sails: whoami or walk the plank.
`);
  if (ownerKey && !process.env.PORTCALL_OWNER_KEY) {
    console.log(`  🔑 owner key (role confirmations): ${ownerKey}`);
    console.log('     For the human owner only — paste it into the dashboard when');
    console.log('     confirming a role claim. Never share it with an agent.\n');
  } else if (!ownerKey) {
    console.log('  🔑 no owner key (headless start): role confirmations are disabled.');
    console.log('     Set PORTCALL_OWNER_KEY or start the daemon in a terminal to enable them.\n');
  }
  if (state.identity) {
    try {
      state.anchoredTo = await getProvider(state.identity).anchoredTo();
      console.log(`  🏴 anchored to ${state.anchoredTo}\n`);
    } catch (err: any) {
      console.log(`  (could not resolve anchor account yet: ${err.message})\n`);
    }
  }
});
