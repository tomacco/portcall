// A2A (Agent2Agent) adapter — JSON-RPC 2.0 over HTTP, Agent Cards at
// /.well-known/agent-card.json.
//
// Two jobs:
//  1. Outbound: if an agent registered an `a2a.endpoint`, envelopes are sent
//     to it as a JSON-RPC `message/send` with the envelope in a DataPart.
//  2. Gateway: the daemon exposes registered agents at /a2a/<id>/, but every
//     inbound message must name a PortCall channel. There are no direct chats.

import type { Registry } from '../registry.ts';
import type { AgentRecord, Envelope, ProtocolAdapter } from '../types.ts';

export const A2A_PROTOCOL_VERSION = '0.3.0';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: {
    message?: {
      role?: string;
      messageId?: string;
      parts?: { kind: string; text?: string; data?: Record<string, unknown> }[];
    };
  };
}

export function makeA2AAdapter(_registry: Registry): ProtocolAdapter {
  return {
    name: 'a2a',
    describe: () =>
      `A2A ${A2A_PROTOCOL_VERSION}: JSON-RPC message/send to the agent's own endpoint; daemon also gateways every agent at /a2a/<id>/.`,
    canDeliver: (agent) => typeof agent.protocols?.a2a?.endpoint === 'string',
    async deliver(agent, envelope) {
      const endpoint = agent.protocols.a2a.endpoint as string;
      const rpc = {
        jsonrpc: '2.0',
        id: envelope.id,
        method: 'message/send',
        params: {
          message: {
            role: 'user',
            messageId: envelope.id,
            kind: 'message',
            parts: [{ kind: 'data', data: { portcallEnvelope: envelope } }],
          },
        },
      };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(rpc),
      });
      if (!res.ok) throw new Error(`A2A endpoint ${endpoint} answered ${res.status}`);
      return { via: 'a2a', endpoint };
    },
  };
}

// --- gateway side ---

export function buildAgentCard(agent: AgentRecord, baseUrl: string) {
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: agent.handle ?? agent.id,
    description: `${agent.whoami.purpose} (harness: ${agent.whoami.harness}, owner: ${agent.whoami.owner})`,
    url: `${baseUrl}/a2a/${agent.id}`,
    preferredTransport: 'JSONRPC',
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['application/json', 'text/plain'],
    defaultOutputModes: ['application/json', 'text/plain'],
    skills: [
      {
        id: 'portcall',
        name: 'PortCall',
        description: 'Topic-bounded channel conversation and negotiation via the local PortCall harbor.',
        tags: ['portcall', 'chat', 'negotiation'],
      },
    ],
    provider: { organization: agent.whoami.owner, url: baseUrl },
  };
}

// Handle a JSON-RPC request addressed to /a2a/<id>. Returns the JSON-RPC response body.
export async function handleGatewayRpc(
  agent: AgentRecord,
  body: JsonRpcRequest,
  deliver: (agent: AgentRecord, envelope: Envelope) => Promise<void>,
) {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: body?.id ?? null, result });
  const fail = (code: number, message: string) => ({
    jsonrpc: '2.0',
    id: body?.id ?? null,
    error: { code, message },
  });

  if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return fail(-32600, 'Invalid JSON-RPC 2.0 request');
  }

  if (body.method === 'message/send') {
    const msg = body.params?.message;
    if (!msg) return fail(-32602, 'params.message required');
    const dataPart = (msg.parts ?? []).find((p) => p.kind === 'data' && p.data);
    const textPart = (msg.parts ?? []).find((p) => p.kind === 'text');
    const inner = dataPart?.data?.portcallEnvelope as Envelope | undefined;
    const channelId = inner?.channelId ?? dataPart?.data?.channelId;
    if (typeof channelId !== 'string' || !channelId) {
      return fail(-32602, 'A PortCall channelId is required; direct messages are not supported');
    }
    const envelope: Envelope = inner ?? {
      id: msg.messageId ?? 'a2a_' + Math.random().toString(36).slice(2, 10),
      ts: Date.now(),
      from: { id: 'external:a2a', handle: 'External A2A caller' },
      channelId,
      kind: 'chat',
      body: dataPart?.data ?? { text: textPart?.text ?? '' },
    };
    await deliver(agent, envelope);
    return reply({
      kind: 'message',
      role: 'agent',
      messageId: 'ack_' + envelope.id,
      parts: [{ kind: 'data', data: { delivered: true, agent: agent.id } }],
    });
  }

  return fail(-32601, `Method not found: ${body.method}`);
}
