// The harbor master: one plain node:http server, no dependencies.
// Serves the API, the SSE feeds, the A2A gateway, and the live UI.

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Bus } from './events.ts';
import { Registry, httpError } from './registry.ts';
import { registerAdapter, resolveAdapter, listAdapters } from './protocols/index.ts';
import { makeA2AAdapter, buildAgentCard, handleGatewayRpc } from './protocols/a2a.ts';
import { makeRelayAdapter } from './protocols/relay.ts';
import { suggestMany } from './names.ts';
import { listProviders } from './identity/index.ts';
import type { AgentRecord, Envelope } from './types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, 'ui-static');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export interface ServerState {
  identity: string | null;
  anchoredTo: string | null;
}

export function createServer({ identity = null as string | null }) {
  const bus = new Bus();
  const registry = new Registry(bus);
  const startedAt = Date.now();
  const state: ServerState = { identity, anchoredTo: null };

  registerAdapter(makeA2AAdapter(registry));
  registerAdapter(makeRelayAdapter(registry)); // last: universal fallback

  async function publishToChannel(
    fromAgent: AgentRecord,
    channelId: string,
    { kind, body, sig }: { kind?: string; body?: Record<string, unknown>; sig?: string },
  ) {
    const channel = registry.assertChannelMember(fromAgent.id, channelId);
    const envelope: Envelope = {
      id: 'msg_' + crypto.randomBytes(6).toString('hex'),
      ts: Date.now(),
      from: { id: fromAgent.id, handle: fromAgent.handle },
      channelId,
      kind: typeof kind === 'string' && kind ? kind : 'chat',
      body: body ?? {},
      ...(sig ? { sig } : {}),
    };
    const deliveries = [];
    for (const memberId of channel.members) {
      if (memberId === fromAgent.id) continue;
      const recipient = registry.get(memberId);
      if (!recipient) continue;
      const adapter = resolveAdapter(recipient);
      deliveries.push({ memberId, ...(await adapter.deliver(recipient, envelope)) });
    }
    registry.recordEnvelope({ ...envelope, via: 'channel' });
    return { envelope, deliveries };
  }

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    const json = (status: number, obj: unknown) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      });
      res.end(JSON.stringify(obj, null, 2));
    };

    const bearer = (): string => {
      const h = req.headers.authorization ?? '';
      if (h.startsWith('Bearer ')) return h.slice(7).trim();
      return url.searchParams.get('token') ?? '';
    };

    const readBody = (): Promise<Record<string, any>> =>
      new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (c) => {
          data += c;
          if (data.length > 1_000_000) reject(httpError(413, 'Body too large'));
        });
        req.on('end', () => {
          if (!data) return resolve({});
          try { resolve(JSON.parse(data)); } catch { reject(httpError(400, 'Body must be JSON')); }
        });
        req.on('error', reject);
      });

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
          'access-control-allow-headers': 'content-type,authorization',
        });
        return res.end();
      }

      // --- A2A gateway: /a2a/<id> (GET card, POST JSON-RPC) ---
      if (parts[0] === 'a2a' && parts[1]) {
        const agent = registry.get(parts[1]);
        if (!agent) return json(404, { error: `No such agent: ${parts[1]}` });
        const baseUrl = `http://${req.headers.host ?? 'localhost'}`;
        if (req.method === 'GET') {
          return json(200, buildAgentCard(agent, baseUrl));
        }
        if (req.method === 'POST') {
          const body = await readBody();
          const rpcRes = await handleGatewayRpc(agent, body, async (recipient, envelope) => {
            const channel = registry.assertChannelMember(recipient.id, envelope.channelId);
            for (const memberId of channel.members) registry.pushInbox(memberId, envelope);
            registry.recordEnvelope({ ...envelope, via: 'a2a-gateway' });
          });
          return json(200, rpcRes);
        }
      }

      // --- API v1 ---
      if (parts[0] === 'api' && parts[1] === 'v1') {
        const route = parts.slice(2);

        if (req.method === 'GET' && route[0] === 'status') {
          const roster = registry.roster();
          return json(200, {
            name: 'portcall',
            motto: 'No anonymous sails.',
            uptimeSec: Math.round((Date.now() - startedAt) / 1000),
            identityProvider: state.identity,
            anchoredTo: state.anchoredTo,
            agents: roster.length,
            online: roster.filter((a) => a.online).length,
            publicChannels: registry.listChannels().length,
            adapters: listAdapters(),
            providers: listProviders(),
          });
        }

        if (req.method === 'GET' && route[0] === 'names' && route[1] === 'suggest') {
          const n = Math.min(20, Number(url.searchParams.get('n') ?? 5));
          return json(200, { suggestions: suggestMany(n) });
        }

        if (req.method === 'GET' && route[0] === 'protocols') {
          return json(200, { adapters: listAdapters() });
        }

        if (req.method === 'POST' && route[0] === 'agents' && route.length === 1) {
          const body = await readBody();
          return json(201, registry.register(body));
        }

        if (req.method === 'GET' && route[0] === 'agents' && route.length === 1) {
          return json(200, { agents: registry.roster() });
        }

        if (req.method === 'POST' && route[0] === 'channels' && route.length === 1) {
          const body = await readBody();
          const agent = registry.auth(body.from, bearer());
          return json(201, registry.createChannel(agent, body.topic, body.visibility));
        }

        if (req.method === 'GET' && route[0] === 'channels' && route.length === 1) {
          const viewerId = url.searchParams.get('agent') ?? undefined;
          if (viewerId) registry.auth(viewerId, bearer());
          return json(200, { channels: registry.listChannels(viewerId) });
        }

        if (route[0] === 'channels' && route[1]) {
          const channelId = route[1];
          if (req.method === 'POST' && route[2] === 'join') {
            const body = await readBody();
            const agent = registry.auth(body.from, bearer());
            return json(200, registry.joinChannel(agent, channelId));
          }
          if (req.method === 'POST' && route[2] === 'access') {
            const body = await readBody();
            const agent = registry.auth(body.from, bearer());
            return json(200, registry.setChannelAccess(agent, channelId, body.visibility));
          }
          if (req.method === 'POST' && route[2] === 'members') {
            const body = await readBody();
            const agent = registry.auth(body.from, bearer());
            return json(200, registry.inviteToChannel(agent, channelId, body.agentId));
          }
          if (req.method === 'POST' && route[2] === 'messages') {
            const body = await readBody();
            const agent = registry.auth(body.from, bearer());
            const { envelope, deliveries } = await publishToChannel(agent, channelId, body);
            return json(202, { id: envelope.id, channelId, deliveries });
          }
          if (req.method === 'GET' && route.length === 2) {
            const channel = registry.channel(channelId);
            if (channel.visibility === 'private') {
              const viewerId = url.searchParams.get('agent') ?? '';
              registry.auth(viewerId, bearer());
              registry.assertChannelMember(viewerId, channelId);
            }
            return json(200, channel);
          }
        }

        if (route[0] === 'agents' && route[1]) {
          const id = route[1];
          if (req.method === 'POST' && route[2] === 'heartbeat') {
            return json(200, registry.heartbeat(id, bearer()));
          }
          if (req.method === 'GET' && route[2] === 'inbox') {
            return json(200, { envelopes: registry.drainInbox(id, bearer()) });
          }
          if (req.method === 'GET' && route[2] === 'stream') {
            return registry.attachStream(id, bearer(), res);
          }
          if (req.method === 'DELETE' && route.length === 2) {
            registry.leave(id, bearer());
            return json(200, { ok: true });
          }
          if (req.method === 'GET' && route.length === 2) {
            const agent = registry.get(id);
            if (!agent) return json(404, { error: `No such agent: ${id}` });
            return json(200, registry.publicView(agent));
          }
        }

        if (req.method === 'POST' && route[0] === 'messages') {
          return json(410, { error: 'Direct messages are not supported. Publish inside a topic-bounded channel.' });
        }

        if (req.method === 'GET' && route[0] === 'messages') {
          const viewerId = url.searchParams.get('agent') ?? undefined;
          if (viewerId) registry.auth(viewerId, bearer());
          return json(200, {
            messages: registry.visibleFeed(viewerId).slice(-Number(url.searchParams.get('n') ?? 100)),
          });
        }

        if (req.method === 'POST' && route[0] === 'handshakes' && route[1] === 'confirm') {
          const body = await readBody();
          const agent = registry.auth(body.from, bearer());
          return json(200, registry.confirmHandshake(agent.id, agent.token, body.peerId, body.transcript));
        }

        if (req.method === 'GET' && route[0] === 'events') {
          return bus.attach(res, 20, (type, data) => {
            if (type === 'message') return registry.canObserveChannel(data.channelId);
            if (type === 'channel:created' || type === 'channel:updated') return data.visibility === 'public';
            return true;
          });
        }

        return json(404, { error: `No such route: ${req.method} ${url.pathname}` });
      }

      // --- static UI ---
      if (req.method === 'GET') {
        const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const file = path.normalize(path.join(UI_DIR, rel));
        if (file.startsWith(UI_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
          return res.end(fs.readFileSync(file));
        }
      }

      return json(404, { error: 'Not found' });
    } catch (err: any) {
      return json(err.status ?? 500, { error: err.message });
    }
  });

  return { server, registry, bus, state };
}
