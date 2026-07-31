// The harbor roster. In-memory on purpose: agents are ephemeral, the roster
// should be too. Restart the daemon, everyone re-registers. No stale ghosts.

import crypto from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { Bus } from './events.ts';
import type { AgentRecord, Envelope, PublicAgent, RegistrationRequest, Whoami } from './types.ts';

const ONLINE_WINDOW_MS = 45_000;

// THE WHO-YOU-ARE RULE (mandatory — the one hard law of the harbor):
// every agent must declare harness, owner, and purpose. No anonymous sails.
const REQUIRED_WHOAMI = ['harness', 'owner', 'purpose'] as const;

interface HandshakeEntry {
  reports: Record<string, string>;
  verified: boolean;
}

export class Registry {
  private agents = new Map<string, AgentRecord>();
  private inboxes = new Map<string, Envelope[]>();
  private streams = new Map<string, Set<ServerResponse>>();
  private handshakes = new Map<string, HandshakeEntry>();
  feed: Envelope[] = [];
  private bus: Bus;

  constructor(bus: Bus) {
    this.bus = bus;
  }

  register({ handle, whoami, extras, protocols }: RegistrationRequest) {
    if (!whoami || typeof whoami !== 'object') {
      throw httpError(422, 'The Who-You-Are rule is mandatory: send a whoami object.');
    }
    const missing = REQUIRED_WHOAMI.filter(
      (k) => typeof whoami[k] !== 'string' || whoami[k].trim() === '',
    );
    if (missing.length) {
      throw httpError(422, `Who are you? whoami is missing: ${missing.join(', ')}. No anonymous sails in this harbor.`);
    }
    const checked = whoami as Whoami;
    const id = 'ag_' + crypto.randomBytes(6).toString('hex');
    const token = crypto.randomBytes(24).toString('hex');
    const agent: AgentRecord = {
      id,
      handle: (handle && String(handle).trim()) || null, // silly name: encouraged, not enforced
      whoami: {
        harness: checked.harness.trim(),
        owner: checked.owner.trim(),
        purpose: checked.purpose.trim(),
        ...(typeof checked.model === 'string' ? { model: checked.model.trim() } : {}),
      },
      extras: extras && typeof extras === 'object' ? extras : {},
      protocols: protocols && typeof protocols === 'object' ? protocols : {},
      registeredAt: Date.now(),
      lastSeen: Date.now(),
      token,
    };
    this.agents.set(id, agent);
    this.inboxes.set(id, []);
    this.bus.emit('agent:joined', this.publicView(agent));
    return { id, token, agent: this.publicView(agent) };
  }

  auth(id: string, token: string): AgentRecord {
    const agent = this.agents.get(id);
    if (!agent || agent.token !== token) throw httpError(401, 'Unknown agent or bad token.');
    agent.lastSeen = Date.now();
    return agent;
  }

  heartbeat(id: string, token: string) {
    this.auth(id, token);
    return { ok: true };
  }

  leave(id: string, token: string): void {
    const agent = this.auth(id, token);
    this.agents.delete(id);
    this.inboxes.delete(id);
    this.bus.emit('agent:left', { id, handle: agent.handle });
  }

  get(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  isOnline(agent: AgentRecord): boolean {
    return Date.now() - agent.lastSeen < ONLINE_WINDOW_MS;
  }

  publicView(agent: AgentRecord): PublicAgent {
    return {
      id: agent.id,
      handle: agent.handle,
      whoami: agent.whoami,
      extras: agent.extras,
      protocols: Object.keys(agent.protocols),
      online: this.isOnline(agent),
      registeredAt: agent.registeredAt,
      verifiedWith: this.verifiedPeers(agent.id),
    };
  }

  roster(): PublicAgent[] {
    return [...this.agents.values()].map((a) => this.publicView(a));
  }

  // --- messaging (adapters call these) ---

  recordEnvelope(envelope: Envelope): void {
    this.feed.push(envelope);
    if (this.feed.length > 500) this.feed.shift();
    this.bus.emit('message', envelope);
  }

  pushInbox(id: string, envelope: Envelope): void {
    const box = this.inboxes.get(id);
    if (!box) throw httpError(404, `No such agent: ${id}`);
    box.push(envelope);
    if (box.length > 200) box.shift();
    const streams = this.streams.get(id);
    if (streams) {
      const line = `event: envelope\ndata: ${JSON.stringify(envelope)}\n\n`;
      for (const res of streams) {
        try { res.write(line); } catch { streams.delete(res); }
      }
    }
  }

  drainInbox(id: string, token: string): Envelope[] {
    this.auth(id, token);
    const box = this.inboxes.get(id) ?? [];
    this.inboxes.set(id, []);
    return box;
  }

  attachStream(id: string, token: string, res: ServerResponse): void {
    this.auth(id, token);
    if (!this.streams.has(id)) this.streams.set(id, new Set());
    const set = this.streams.get(id)!;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(':ahoy\n\n');
    set.add(res);
    const ping = setInterval(() => {
      try { res.write(':ping\n\n'); } catch { /* closed */ }
    }, 15000);
    res.on('close', () => {
      clearInterval(ping);
      set.delete(res);
    });
  }

  // --- handshake bookkeeping (the daemon never sees the anchor secret; it
  // only checks that both sides independently report the same transcript) ---

  confirmHandshake(id: string, token: string, peerId: string, transcript: string) {
    this.auth(id, token);
    const peer = this.agents.get(peerId);
    if (!peer) throw httpError(404, `No such peer: ${peerId}`);
    const key = [id, peerId].sort().join('~');
    const entry = this.handshakes.get(key) ?? { reports: {}, verified: false };
    entry.reports[id] = transcript;
    const [a, b] = key.split('~');
    entry.verified =
      !!entry.reports[a] && !!entry.reports[b] && entry.reports[a] === entry.reports[b];
    this.handshakes.set(key, entry);
    this.bus.emit('handshake', {
      pair: [a, b],
      verified: entry.verified,
      reportedBy: id,
    });
    return { verified: entry.verified };
  }

  verifiedPeers(id: string): string[] {
    const out: string[] = [];
    for (const [key, entry] of this.handshakes) {
      if (!entry.verified) continue;
      const [a, b] = key.split('~');
      if (a === id) out.push(b);
      else if (b === id) out.push(a);
    }
    return out;
  }
}

export function httpError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}
