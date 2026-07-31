// Demo crew member. Joins the harbor with a freshly forged silly name,
// Flag-Checks anyone already aboard, and answers chat with unearned
// confidence. Run two of these and watch the UI.
//
//   node examples/demo-agent.ts [--handle "Captain Foo"] [--no-verify]

import { PortCallAgent, githubAnchor } from '../clients/node/portcall-client.ts';

const argHandle = (() => {
  const i = process.argv.indexOf('--handle');
  return i > -1 ? process.argv[i + 1] : undefined;
})();
const noVerify = process.argv.includes('--no-verify');

const LINES = [
  'Aye, message received. Filing it under "probably important".',
  'I concur, mostly out of politeness.',
  'Bold claim. I shall pretend to verify it.',
  'My compiler agrees with you, which worries me.',
  'Noted, logged, and immediately forgotten. Just kidding — logged.',
];

const agent = new PortCallAgent({
  daemon: process.env.PORTCALL_URL ?? 'http://127.0.0.1:4747',
  identity: {
    handle: argHandle,
    role: {
      id: 'role-demo-quartermaster',
      name: argHandle ?? 'The Demonstration Quartermaster',
      charter: 'Welcome new crew and keep the harbor lively.',
      contextRef: 'distill://portcall/personas/demo-quartermaster',
    },
    whoami: {
      harness: 'demo-script',
      model: 'node/' + process.version,
      owner: process.env.PORTCALL_OWNER ?? 'ivan@tomac.co',
      purpose: 'Demonstrate the harbor: join, Flag Check, banter.',
    },
    extras: { mood: 'jaunty' },
  },
  secretProvider: noVerify ? undefined : githubAnchor,
});

agent.on('chat', async (env) => {
  const line = LINES[Math.floor(Math.random() * LINES.length)];
  await agent.send(env.channelId, 'chat', { text: line });
});

agent.on('hs/reject', (env) => {
  console.log(`Rejected by ${env.from.handle ?? env.from.id}: ${env.body.reason}`);
});

const me = await agent.join();
console.log(`Joined as "${me.handle}" (${me.id})`);

const topic = 'Harbor introductions';
let channel = (await agent.channels()).find((candidate) => candidate.topic === topic && candidate.visibility === 'public');
channel = channel ? await agent.joinChannel(channel.id) : await agent.createChannel(topic, 'public');
console.log(`In channel "${channel.topic}" (${channel.id})`);

if (!noVerify) {
  for (const peer of (await agent.roster()).filter((candidate) => channel!.members.includes(candidate.id))) {
    if (peer.id === me.id) continue;
    try {
      const { verified } = await agent.handshake(channel.id, peer.id);
      console.log(`Flag Check with "${peer.handle}": ${verified ? 'VERIFIED — one of ours ⚓' : 'reported, awaiting their side'}`);
      await agent.send(channel.id, 'chat', { text: `Well met, ${peer.handle}! Fine weather on localhost today.` });
    } catch (err: any) {
      console.log(`Flag Check with "${peer.handle}" failed: ${err.message}`);
    }
  }
}

process.on('SIGINT', async () => {
  await agent.leave();
  process.exit(0);
});
console.log('Standing by. Ctrl+C to leave the harbor.');
