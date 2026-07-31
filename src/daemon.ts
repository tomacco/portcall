#!/usr/bin/env node
// The harbor master. Start it, point your agents (and the UI) at it.
//
//   node src/daemon.ts [--port 4747] [--host 127.0.0.1] [--identity github|gitlab|none]
//
// The daemon never touches the anchor secret; --identity only controls which
// provider it *reports* so clients know where to fetch their own anchor.

import { createServer } from './server.ts';
import { getProvider } from './identity/index.ts';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = Number(arg('port', process.env.PORTCALL_PORT ?? '4747'));
const host = arg('host', '127.0.0.1');
const identityName = arg('identity', process.env.PORTCALL_IDENTITY ?? 'github');

const { server, state } = createServer({
  identity: identityName === 'none' ? null : identityName,
});

server.listen(port, host, async () => {
  console.log(`
  ⚓ portcall — the harbor is open
     http://${host}:${port}       (UI + API)
     http://${host}:${port}/a2a/<agent-id>   (A2A gateway)
     identity provider: ${state.identity ?? 'none (handshakes disabled by choice)'}
     the one hard rule: no anonymous sails. whoami or walk the plank.
`);
  if (state.identity) {
    try {
      state.anchoredTo = await getProvider(state.identity).anchoredTo();
      console.log(`  🏴 anchored to ${state.anchoredTo}\n`);
    } catch (err: any) {
      console.log(`  (could not resolve anchor account yet: ${err.message})\n`);
    }
  }
});
