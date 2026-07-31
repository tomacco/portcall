// PortCall client for Node/TS harnesses. Registers, streams the inbox over SSE,
// and speaks the Flag Check handshake fluently (initiator AND responder —
// hand it a secretProvider and it defends its honor automatically).

import {
  mac, safeEqual, nonce, sessionKey, transcriptHash,
} from '../../src/handshake.ts';
import type { ChannelRecord, ChannelVisibility, Envelope, PublicAgent, RoleIdentity, Whoami } from '../../src/types.ts';

export interface AgentIdentity {
  handle?: string;
  role?: RoleIdentity;
  whoami: Whoami;
  extras?: Record<string, unknown>;
  protocols?: Record<string, { endpoint?: string }>;
}

export interface HandshakeResult {
  peer: string;
  verified: boolean;
  transcript: string;
}

type EnvelopeHandler = (env: Envelope) => void | Promise<void>;

interface InitiatorState {
  role: 'initiator';
  channelId: string;
  nA: string;
  secret: string;
  resolve: (r: HandshakeResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface ResponderState {
  role: 'responder';
  channelId: string;
  nA: string;
  nB: string;
  secret: string;
}

export class PortCallAgent {
  daemon: string;
  identity: AgentIdentity;
  secretProvider?: () => Promise<string>;
  id: string | null = null;
  token: string | null = null;
  sessions = new Map<string, string>(); // peerId -> session key (hex)

  private handlers = new Map<string, EnvelopeHandler[]>();
  private pending = new Map<string, InitiatorState | ResponderState>();
  private abort: AbortController | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private anchor: string | null = null;

  private pendingKey(channelId: string, peerId: string): string {
    return `${channelId}~${peerId}`;
  }

  constructor(opts: {
    daemon?: string;
    identity: AgentIdentity;
    secretProvider?: () => Promise<string>;
  }) {
    this.daemon = (opts.daemon ?? 'http://127.0.0.1:4747').replace(/\/$/, '');
    this.identity = opts.identity;
    this.secretProvider = opts.secretProvider;
  }

  private async api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(this.daemon + path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async join(): Promise<PublicAgent> {
    if (!this.identity.handle) {
      const { suggestions } = await this.api<{ suggestions: string[] }>('/api/v1/names/suggest?n=1');
      this.identity = { ...this.identity, handle: suggestions[0] };
    }
    const reg = await this.api<{ id: string; token: string; agent: PublicAgent }>('/api/v1/agents', {
      method: 'POST',
      body: JSON.stringify(this.identity),
    });
    this.id = reg.id;
    this.token = reg.token;
    this.openStream();
    this.heartbeatTimer = setInterval(
      () => this.api(`/api/v1/agents/${this.id}/heartbeat`, { method: 'POST' }).catch(() => {}),
      20_000,
    );
    return reg.agent;
  }

  async leave(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.abort?.abort();
    if (this.id) await this.api(`/api/v1/agents/${this.id}`, { method: 'DELETE' }).catch(() => {});
  }

  async roster(): Promise<PublicAgent[]> {
    return (await this.api<{ agents: PublicAgent[] }>(`/api/v1/agents?agent=${this.id}`)).agents;
  }

  on(kind: string, fn: EnvelopeHandler): this {
    if (!this.handlers.has(kind)) this.handlers.set(kind, []);
    this.handlers.get(kind)!.push(fn);
    return this;
  }

  async channels(): Promise<ChannelRecord[]> {
    return (await this.api<{ channels: ChannelRecord[] }>(`/api/v1/channels?agent=${this.id}`)).channels;
  }

  async createChannel(topic: string, visibility: ChannelVisibility = 'private'): Promise<ChannelRecord> {
    return this.api('/api/v1/channels', {
      method: 'POST', body: JSON.stringify({ from: this.id, topic, visibility }),
    });
  }

  async joinChannel(channelId: string): Promise<ChannelRecord> {
    return this.api(`/api/v1/channels/${channelId}/join`, {
      method: 'POST', body: JSON.stringify({ from: this.id }),
    });
  }

  async invite(channelId: string, agentId: string): Promise<ChannelRecord> {
    return this.api(`/api/v1/channels/${channelId}/members`, {
      method: 'POST', body: JSON.stringify({ from: this.id, agentId }),
    });
  }

  async setChannelAccess(channelId: string, visibility: ChannelVisibility): Promise<ChannelRecord> {
    return this.api(`/api/v1/channels/${channelId}/access`, {
      method: 'POST', body: JSON.stringify({ from: this.id, visibility }),
    });
  }

  async send(channelId: string, kind: string, body: Record<string, unknown>): Promise<{ id: string; channelId: string }> {
    return this.api(`/api/v1/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ from: this.id, kind, body }),
    });
  }

  // --- Flag Check handshake (initiator) ---
  async handshake(channelId: string, peerId: string, { timeoutMs = 15_000 } = {}): Promise<HandshakeResult> {
    const secret = await this.secret();
    const nA = nonce();
    const key = this.pendingKey(channelId, peerId);
    const done = new Promise<HandshakeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`Handshake with ${peerId} timed out`));
      }, timeoutMs);
      this.pending.set(key, { role: 'initiator', channelId, nA, secret, resolve, reject, timer });
    });
    await this.send(channelId, 'hs/hello', { n: nA, peerId });
    return done;
  }

  private async secret(): Promise<string> {
    if (!this.secretProvider) {
      throw new Error('No secretProvider configured — this agent cannot run the Flag Check.');
    }
    if (!this.anchor) this.anchor = await this.secretProvider();
    return this.anchor;
  }

  private async confirm(channelId: string, peerId: string, transcript: string): Promise<boolean> {
    const { matched } = await this.api<{ matched: boolean }>('/api/v1/handshakes/confirm', {
      method: 'POST',
      body: JSON.stringify({ from: this.id, channelId, peerId, transcript }),
    });
    return matched;
  }

  private async handleEnvelope(env: Envelope): Promise<void> {
    const peer = env.from.id;
    const key = this.pendingKey(env.channelId, peer);
    try {
      if (env.kind === 'hs/hello') {
        if (env.body.peerId !== this.id) return;
        const secret = await this.secret();
        const nB = nonce();
        const nA = String(env.body.n);
        this.pending.set(key, { role: 'responder', channelId: env.channelId, nA, nB, secret });
        await this.send(env.channelId, 'hs/challenge', { n: nB, mac: mac(secret, nA, nB, this.id!), peerId: peer });
        return;
      }
      if (env.kind === 'hs/challenge') {
        if (env.body.peerId !== this.id) return;
        const st = this.pending.get(key);
        if (!st || st.role !== 'initiator') return;
        const nB = String(env.body.n);
        const theirMac = String(env.body.mac);
        if (!safeEqual(theirMac, mac(st.secret, st.nA, nB, peer))) {
          clearTimeout(st.timer);
          this.pending.delete(key);
          st.reject(new Error(`Peer ${peer} FAILED the Flag Check (bad MAC). Not one of ours.`));
          return;
        }
        await this.send(env.channelId, 'hs/proof', { mac: mac(st.secret, nB, st.nA, this.id!), peerId: peer });
        const transcript = transcriptHash(st.nA, nB, this.id!, peer);
        this.sessions.set(peer, sessionKey(st.secret, st.nA, nB));
        const verified = await this.confirm(env.channelId, peer, transcript);
        clearTimeout(st.timer);
        this.pending.delete(key);
        st.resolve({ peer, verified, transcript });
        return;
      }
      if (env.kind === 'hs/proof') {
        if (env.body.peerId !== this.id) return;
        const st = this.pending.get(key);
        if (!st || st.role !== 'responder') return;
        if (!safeEqual(String(env.body.mac), mac(st.secret, st.nB, st.nA, peer))) {
          this.pending.delete(key);
          await this.send(env.channelId, 'hs/reject', { reason: 'Bad proof. You do not fly my flag.', peerId: peer });
          return;
        }
        const transcript = transcriptHash(st.nA, st.nB, peer, this.id!);
        this.sessions.set(peer, sessionKey(st.secret, st.nA, st.nB));
        this.pending.delete(key);
        await this.confirm(env.channelId, peer, transcript);
        return;
      }
    } catch (err: any) {
      // A handshake failing must never kill the message loop.
      console.error(`[portcall-client] handshake error with ${peer}: ${err.message}`);
    }

    for (const fn of this.handlers.get(env.kind) ?? []) await fn(env);
    for (const fn of this.handlers.get('*') ?? []) await fn(env);
  }

  private openStream(): void {
    this.abort = new AbortController();
    const url = `${this.daemon}/api/v1/agents/${this.id}/stream?token=${this.token}`;
    void (async () => {
      while (!this.abort!.signal.aborted) {
        try {
          const res = await fetch(url, { signal: this.abort!.signal });
          if (!res.body) throw new Error('no body');
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buf.indexOf('\n\n')) > -1) {
              const chunk = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
              if (dataLine) {
                try { await this.handleEnvelope(JSON.parse(dataLine.slice(6))); } catch { /* skip */ }
              }
            }
          }
        } catch {
          if (this.abort!.signal.aborted) return;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    })();
  }
}

// Convenience: anchor fetchers that mirror src/identity/ providers.
export async function githubAnchor(): Promise<string> {
  const { githubProvider } = await import('../../src/identity/github.ts');
  return githubProvider.getAnchor();
}
export async function gitlabAnchor(): Promise<string> {
  const { gitlabProvider } = await import('../../src/identity/gitlab.ts');
  return gitlabProvider.getAnchor();
}
