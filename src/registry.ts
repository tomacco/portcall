// The harbor roster. In-memory on purpose: agents are ephemeral, the roster
// should be too. Restart the daemon, everyone re-registers. No stale ghosts.

import crypto from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { Bus } from './events.ts';
import type { AgentRecord, ChannelRecord, ChannelVisibility, Envelope, PublicAgent, RegistrationRequest, Whoami } from './types.ts';

const ONLINE_WINDOW_MS = 45_000;

// SessionEnd deregistration is best-effort (crashes, killed terminals), so
// ghost entries accumulate. Anything silent this long is gone; a live session
// that outlasts the window re-registers on its next prompt. Agents holding an
// open SSE stream are never evicted — connected is not silent.
const EVICT_AFTER_MS = 24 * 60 * 60 * 1000;

// THE WHO-YOU-ARE RULE (mandatory — the one hard law of the harbor):
// every agent must declare harness, owner, and purpose. No anonymous sails.
const REQUIRED_WHOAMI = ['harness', 'owner', 'purpose'] as const;

interface HandshakeEntry {
  channelId: string;
  pair: [string, string];
  reports: Record<string, string>;
  matched: boolean;
}

export class Registry {
  private agents = new Map<string, AgentRecord>();
  private inboxes = new Map<string, Envelope[]>();
  private streams = new Map<string, Set<ServerResponse>>();
  private handshakes = new Map<string, HandshakeEntry>();
  private channels = new Map<string, ChannelRecord>();
  feed: Envelope[] = [];
  private bus: Bus;

  constructor(bus: Bus) {
    this.bus = bus;
  }

  register({ handle, role, whoami, extras, protocols }: RegistrationRequest) {
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
    const roleName = (role?.name && String(role.name).trim()) || (handle && String(handle).trim()) || id;
    const roleId = (role?.id && String(role.id).trim()) || id;
    const agent: AgentRecord = {
      id,
      handle: (handle && String(handle).trim()) || null, // silly name: encouraged, not enforced
      whoami: {
        harness: checked.harness.trim(),
        owner: checked.owner.trim(),
        purpose: checked.purpose.trim(),
        ...(typeof checked.model === 'string' ? { model: checked.model.trim() } : {}),
      },
      role: {
        id: roleId,
        name: roleName,
        ...(typeof role?.charter === 'string' && role.charter.trim() ? { charter: role.charter.trim() } : {}),
        ...(typeof role?.contextRef === 'string' && role.contextRef.trim() ? { contextRef: role.contextRef.trim() } : {}),
      },
      actor: {
        ...(typeof checked.model === 'string' && checked.model.trim() ? { model: checked.model.trim() } : {}),
      },
      vessel: {
        id,
        harness: checked.harness.trim(),
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
    this.removeAgent(agent);
  }

  evictStale(maxSilenceMs: number = EVICT_AFTER_MS): string[] {
    const evicted: string[] = [];
    for (const agent of [...this.agents.values()]) {
      if (Date.now() - agent.lastSeen < maxSilenceMs) continue;
      if (this.streams.get(agent.id)?.size) continue; // attached = alive
      this.removeAgent(agent, 'evicted');
      evicted.push(agent.id);
    }
    return evicted;
  }

  private removeAgent(agent: AgentRecord, reason?: string): void {
    const id = agent.id;
    const streams = this.streams.get(id);
    if (streams) {
      for (const response of streams) {
        try { response.end(); } catch { /* already closed */ }
      }
      this.streams.delete(id);
    }
    this.agents.delete(id);
    this.inboxes.delete(id);
    for (const channel of this.channels.values()) {
      channel.members = channel.members.filter((member) => member !== id);
      channel.moderators = channel.moderators.filter((member) => member !== id);
      if (!channel.members.length) this.channels.delete(channel.id);
      else if (!channel.moderators.length) channel.moderators.push(channel.members[0]);
    }
    for (const [key, handshake] of this.handshakes) {
      if (handshake.pair.includes(id)) this.handshakes.delete(key);
    }
    this.bus.emit('agent:left', { id, handle: agent.handle, ...(reason ? { reason } : {}) });
  }

  get(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  isOnline(agent: AgentRecord): boolean {
    return Date.now() - agent.lastSeen < ONLINE_WINDOW_MS;
  }

  publicView(agent: AgentRecord, viewerId?: string): PublicAgent {
    const { contextRef: _privateContextRef, ...publicRole } = agent.role;
    return {
      id: agent.id,
      handle: agent.handle,
      whoami: agent.whoami,
      role: publicRole,
      actor: agent.actor,
      vessel: agent.vessel,
      protocols: Object.keys(agent.protocols),
      online: this.isOnline(agent),
      registeredAt: agent.registeredAt,
      anchorMatchesWith: this.anchorMatches(agent.id, viewerId),
    };
  }

  roster(viewerId?: string): PublicAgent[] {
    return [...this.agents.values()].map((a) => this.publicView(a, viewerId));
  }

  // --- topic-bounded channels: the only place conversations may happen ---

  createChannel(agent: AgentRecord, topic: unknown, visibility: unknown = 'private'): ChannelRecord {
    if (typeof topic !== 'string' || !topic.trim()) throw httpError(422, 'A channel topic is required.');
    if (visibility !== 'public' && visibility !== 'private') {
      throw httpError(422, 'Channel visibility must be public or private.');
    }
    const channel: ChannelRecord = {
      id: 'ch_' + crypto.randomBytes(6).toString('hex'),
      topic: topic.trim(),
      visibility: visibility as ChannelVisibility,
      createdAt: Date.now(),
      createdBy: agent.id,
      members: [agent.id],
      moderators: [agent.id],
    };
    this.channels.set(channel.id, channel);
    this.bus.emit('channel:created', channel);
    return channel;
  }

  listChannels(viewerId?: string): ChannelRecord[] {
    return [...this.channels.values()].filter(
      (channel) => channel.visibility === 'public' || !!viewerId && channel.members.includes(viewerId),
    );
  }

  channel(id: string): ChannelRecord {
    const channel = this.channels.get(id);
    if (!channel) throw httpError(404, `No such channel: ${id}`);
    return channel;
  }

  joinChannel(agent: AgentRecord, channelId: string): ChannelRecord {
    const channel = this.channel(channelId);
    if (channel.visibility !== 'public' && !channel.members.includes(agent.id)) {
      throw httpError(403, 'This channel is private; a moderator must invite you.');
    }
    if (!channel.members.includes(agent.id)) channel.members.push(agent.id);
    this.bus.emit('channel:updated', channel);
    return channel;
  }

  setChannelAccess(agent: AgentRecord, channelId: string, visibility: unknown): ChannelRecord {
    const channel = this.channel(channelId);
    if (!channel.moderators.includes(agent.id)) throw httpError(403, 'Only channel moderators control admission.');
    if (visibility !== 'public' && visibility !== 'private') {
      throw httpError(422, 'Channel visibility must be public or private.');
    }
    channel.visibility = visibility;
    this.bus.emit('channel:updated', channel);
    return channel;
  }

  inviteToChannel(agent: AgentRecord, channelId: string, memberId: unknown): ChannelRecord {
    const channel = this.channel(channelId);
    if (!channel.moderators.includes(agent.id)) throw httpError(403, 'Only channel moderators can invite agents.');
    if (typeof memberId !== 'string' || !this.agents.has(memberId)) throw httpError(404, `No such agent: ${memberId}`);
    if (!channel.members.includes(memberId)) channel.members.push(memberId);
    this.bus.emit('channel:updated', channel);
    return channel;
  }

  assertChannelMember(agentId: string, channelId: string): ChannelRecord {
    const channel = this.channel(channelId);
    if (!channel.members.includes(agentId)) throw httpError(403, 'Join the channel before publishing to it.');
    return channel;
  }

  canObserveChannel(channelId: string, viewerId?: string): boolean {
    const channel = this.channels.get(channelId);
    return !!channel && (channel.visibility === 'public' || !!viewerId && channel.members.includes(viewerId));
  }

  visibleFeed(viewerId?: string): Envelope[] {
    return this.feed.filter((envelope) => this.canObserveChannel(envelope.channelId, viewerId));
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

  confirmHandshake(id: string, token: string, channelId: string, peerId: string, transcript: string) {
    this.auth(id, token);
    const peer = this.agents.get(peerId);
    if (!peer) throw httpError(404, `No such peer: ${peerId}`);
    const channel = this.assertChannelMember(id, channelId);
    if (!channel.members.includes(peerId)) throw httpError(403, 'Flag Check peers must share the named channel.');
    const pair = [id, peerId].sort() as [string, string];
    const key = `${channelId}~${pair.join('~')}`;
    const entry = this.handshakes.get(key) ?? { channelId, pair, reports: {}, matched: false };
    entry.reports[id] = transcript;
    const [a, b] = pair;
    entry.matched =
      !!entry.reports[a] && !!entry.reports[b] && entry.reports[a] === entry.reports[b];
    this.handshakes.set(key, entry);
    this.bus.emit('handshake', {
      channelId,
      pair: [a, b],
      matched: entry.matched,
      reportedBy: id,
    });
    return { matched: entry.matched };
  }

  anchorMatches(id: string, viewerId?: string): string[] {
    const out = new Set<string>();
    for (const entry of this.handshakes.values()) {
      if (!entry.matched) continue;
      if (!this.canObserveChannel(entry.channelId, viewerId)) continue;
      const [a, b] = entry.pair;
      if (a === id) out.add(b);
      else if (b === id) out.add(a);
    }
    return [...out];
  }
}

export function httpError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}
