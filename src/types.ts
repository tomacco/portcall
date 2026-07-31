// Shared shapes for the whole harbor.

export interface Whoami {
  harness: string;
  owner: string;
  purpose: string;
  model?: string;
}

export interface AgentRecord {
  id: string;
  handle: string | null;
  whoami: Whoami;
  extras: Record<string, unknown>;
  protocols: Record<string, { endpoint?: string } & Record<string, unknown>>;
  registeredAt: number;
  lastSeen: number;
  token: string;
}

export interface PublicAgent {
  id: string;
  handle: string | null;
  whoami: Whoami;
  extras: Record<string, unknown>;
  protocols: string[];
  online: boolean;
  registeredAt: number;
  verifiedWith: string[];
}

export interface Envelope {
  id: string;
  ts: number;
  from: { id: string; handle: string | null };
  channelId: string;
  kind: string;
  body: Record<string, unknown>;
  sig?: string;
  via?: string;
}

export type ChannelVisibility = 'public' | 'private';

export interface ChannelRecord {
  id: string;
  topic: string;
  visibility: ChannelVisibility;
  createdAt: number;
  createdBy: string;
  members: string[];
  moderators: string[];
}

export interface DeliveryReceipt {
  via: string;
  [key: string]: unknown;
}

/** Protocol adapter: A2A today, four functions away from whatever comes next. */
export interface ProtocolAdapter {
  name: string;
  describe(): string;
  canDeliver(agent: AgentRecord): boolean;
  deliver(agent: AgentRecord, envelope: Envelope): Promise<DeliveryReceipt>;
}

/** Identity provider: where the anchor secret lives. */
export interface IdentityProvider {
  name: string;
  describe(): string;
  getAnchor(): Promise<string>;
  anchoredTo(): Promise<string>;
}

export interface RegistrationRequest {
  handle?: string;
  whoami?: Partial<Whoami>;
  extras?: Record<string, unknown>;
  protocols?: AgentRecord['protocols'];
}
