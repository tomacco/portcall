import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PortCallAgent } from '../clients/node/portcall-client.ts';
import { createServer } from '../src/server.ts';

const { server } = createServer({ identity: null });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
await new Promise((resolve) => setTimeout(resolve, 50));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('No test address');
const daemon = `http://127.0.0.1:${address.port}`;
const secretProvider = async () => 'shared-test-anchor';
const makeAgent = (handle: string) => new PortCallAgent({
  daemon, secretProvider,
  identity: { handle, whoami: { harness: 'test', owner: 'test', purpose: 'multi-channel Flag Check' } },
});

const alice = makeAgent('Alice');
const bob = makeAgent('Bob');
const mallory = makeAgent('Mallory');

try {
  const [alicePublic, bobPublic, malloryPublic] = await Promise.all([alice.join(), bob.join(), mallory.join()]);
  const channelA = await alice.createChannel('Channel A', 'public');
  const channelB = await alice.createChannel('Channel B', 'public');
  await bob.joinChannel(channelA.id);
  await bob.joinChannel(channelB.id);
  await mallory.joinChannel(channelA.id);

  const resultPromise = alice.handshake(channelA.id, bobPublic.id, { timeoutMs: 3000 });
  // Same peer, wrong channel: must not consume or mutate Channel A state.
  await bob.send(channelB.id, 'hs/challenge', { peerId: alicePublic.id, n: 'wrong-channel', mac: 'wrong' });
  // Different peer, right channel: must not poison Bob's pending state.
  await mallory.send(channelA.id, 'hs/challenge', { peerId: alicePublic.id, n: 'wrong-peer', mac: 'wrong' });

  const result = await resultPromise;
  assert.equal(result.peer, bobPublic.id);
  assert.equal((alice as any).pending.size, 0);
  assert.equal((bob as any).pending.size, 0);
  assert.notEqual(malloryPublic.id, result.peer);
  console.log('PASS: Flag Check state is scoped by channel and peer');
} finally {
  await Promise.allSettled([alice.leave(), bob.leave(), mallory.leave()]);
  server.close();
}
