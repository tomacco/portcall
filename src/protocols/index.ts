// Protocol adapter registry. A2A today; whatever comes next, tomorrow.
//
// Delivery resolution: first registered adapter whose canDeliver() says yes.
// 'relay' (daemon-mediated inbox) is registered last as the universal fallback,
// so every agent is reachable even if it can't host a server.

import type { AgentRecord, ProtocolAdapter } from '../types.ts';

const adapters: ProtocolAdapter[] = [];

export function registerAdapter(adapter: ProtocolAdapter): void {
  adapters.push(adapter);
}

export function resolveAdapter(agent: AgentRecord): ProtocolAdapter {
  const found = adapters.find((a) => a.canDeliver(agent));
  if (!found) throw new Error(`No adapter can deliver to agent ${agent.id}`);
  return found;
}

export function listAdapters(): { name: string; about: string }[] {
  return adapters.map((a) => ({ name: a.name, about: a.describe() }));
}
