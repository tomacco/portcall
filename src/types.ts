// Shared shapes for the whole harbor.

export interface Whoami {
  harness: string;
  owner: string;
  purpose: string;
  model?: string;
}

/** A stable collaborative persona identifier. Different actors may adopt it. */
export interface RoleIdentity {
  id: string;
  name: string;
  charter?: string;
  contextRef?: string;
}

/** Safe social projection. Storage locations remain private to the vessel. */
export type PublicRoleIdentity = Omit<RoleIdentity, 'contextRef'> & {
  /** True when the harbor owner confirmed this vessel's claim to the role. */
  confirmed?: boolean;
};

/** The transient process carrying a role into the harbor. */
export interface VesselIdentity {
  id: string;
  harness: string;
}

/** Model provenance for the actor currently interpreting a role. */
export interface ActorIdentity {
  model?: string;
}

export interface AgentRecord {
  id: string;
  handle: string | null;
  whoami: Whoami;
  role: RoleIdentity;
  actor: ActorIdentity;
  vessel: VesselIdentity;
  extras: Record<string, unknown>;
  protocols: Record<string, { endpoint?: string } & Record<string, unknown>>;
  registeredAt: number;
  lastSeen: number;
  token: string;
  /** Set when the harbor owner confirmed this vessel's role claim. */
  roleConfirmedAt?: number;
}

/** A role claim awaiting the owner's code ceremony. The `code` never leaves
 * the claiming vessel's registration response; projections carry only the
 * shuffled `codeOptions`. */
export interface PublicRoleConfirmation {
  id: string;
  vessel: { id: string; handle: string | null; harness: string };
  whoami: Whoami;
  role: PublicRoleIdentity;
  codeOptions: string[];
  requestedAt: number;
  expiresAt: number;
}

export interface PublicAgent {
  id: string;
  handle: string | null;
  whoami: Whoami;
  role: PublicRoleIdentity;
  actor: ActorIdentity;
  vessel: VesselIdentity;
  protocols: string[];
  online: boolean;
  registeredAt: number;
  anchorMatchesWith: string[];
}

export interface Envelope {
  id: string;
  ts: number;
  from: {
    id: string;
    handle: string | null;
    role: PublicRoleIdentity;
    actor: ActorIdentity;
    vessel: VesselIdentity;
  };
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
  role?: Partial<RoleIdentity>;
  whoami?: Partial<Whoami>;
  extras?: Record<string, unknown>;
  protocols?: AgentRecord['protocols'];
}
