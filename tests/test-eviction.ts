// Roster hygiene: ghosts (agents whose SessionEnd never fired) are evicted
// after prolonged silence, with the same full cleanup a voluntary leave gets;
// live and stream-attached agents are never touched.

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { ServerResponse } from 'node:http';
import { Registry } from '../src/registry.ts';
import { Bus } from '../src/events.ts';

const bus = new Bus();
const events: { type: string; data: any }[] = [];
const origEmit = bus.emit.bind(bus);
bus.emit = (type: string, data: unknown) => {
  events.push({ type, data });
  origEmit(type, data);
};
const registry = new Registry(bus);

const whoami = { harness: 'test', owner: 'test', purpose: 'eviction test' };
const DAY_AND_HOUR = 25 * 60 * 60 * 1000;

// -- selectivity: only the silent ghost goes ---------------------------------
const ghost = registry.register({ handle: 'Ghost', whoami });
const live = registry.register({ handle: 'Live', whoami });
registry.get(ghost.id)!.lastSeen = Date.now() - DAY_AND_HOUR;

let evicted = registry.evictStale();
assert.deepEqual(evicted, [ghost.id]);
assert.equal(registry.get(ghost.id), undefined);
assert.ok(registry.get(live.id), 'live agent survives the sweep');

// -- evicted identity is disowned, forcing a clean re-register ---------------
assert.throws(() => registry.auth(ghost.id, ghost.token), /Unknown agent/);

// -- the agent:left event carries the eviction reason ------------------------
const left = events.filter((e) => e.type === 'agent:left').at(-1);
assert.ok(left, 'agent:left emitted');
assert.equal(left!.data.id, ghost.id);
assert.equal(left!.data.reason, 'evicted');

// -- eviction cleans channels and handshakes like a voluntary leave ----------
const peer = registry.register({ handle: 'Peer', whoami });
const stale = registry.register({ handle: 'Stale', whoami });
const channel = registry.createChannel(registry.get(stale.id)!, 'hygiene', 'public');
registry.joinChannel(registry.get(peer.id)!, channel.id);
registry.confirmHandshake(stale.id, stale.token, channel.id, peer.id, 'transcript');
registry.confirmHandshake(peer.id, peer.token, channel.id, stale.id, 'transcript');
assert.deepEqual(registry.anchorMatches(peer.id), [stale.id], 'handshake matched before eviction');

registry.get(stale.id)!.lastSeen = Date.now() - DAY_AND_HOUR;
evicted = registry.evictStale();
assert.deepEqual(evicted, [stale.id]);
assert.ok(!registry.channel(channel.id).members.includes(stale.id), 'evictee removed from channel');
assert.ok(registry.channel(channel.id).moderators.length, 'channel keeps a moderator');
assert.deepEqual(registry.anchorMatches(peer.id), [], 'stale handshake dropped');

// -- an SSE-attached agent is connected, not silent: never evicted -----------
const watcher = registry.register({ handle: 'Watcher', whoami });
const sink = new PassThrough();
(sink as unknown as { writeHead: () => void }).writeHead = () => {};
registry.attachStream(watcher.id, watcher.token, sink as unknown as ServerResponse);
registry.get(watcher.id)!.lastSeen = Date.now() - DAY_AND_HOUR;
evicted = registry.evictStale();
assert.deepEqual(evicted, [], 'stream-attached agent survives silence');
assert.ok(registry.get(watcher.id), 'watcher still aboard');
// Destroy the sink so attachStream's ping interval is cleared and node can exit.
sink.destroy();

// -- evicting the last member deletes the channel ----------------------------
const loner = registry.register({ handle: 'Loner', whoami });
const solo = registry.createChannel(registry.get(loner.id)!, 'solo topic', 'public');
registry.get(loner.id)!.lastSeen = Date.now() - DAY_AND_HOUR;
registry.evictStale();
assert.throws(() => registry.channel(solo.id), /No such channel/, 'empty channel deleted');

// -- a voluntary leave still emits agent:left WITHOUT a reason ---------------
const guest = registry.register({ handle: 'Guest', whoami });
registry.leave(guest.id, guest.token);
const voluntary = events.filter((e) => e.type === 'agent:left').at(-1);
assert.equal(voluntary!.data.id, guest.id);
assert.ok(!('reason' in voluntary!.data), 'voluntary leave carries no reason');

console.log('PASS: stale ghosts evicted with full cleanup; live and attached agents untouched');
