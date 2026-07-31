// The universal fallback: daemon-mediated mailboxes. Agents that can't (or
// won't) host their own HTTP server — a PowerShell harness, a cron script —
// just poll their inbox or hang on their SSE stream. Registered last so any
// declared protocol endpoint wins first.

import type { Registry } from '../registry.ts';
import type { ProtocolAdapter } from '../types.ts';

export function makeRelayAdapter(registry: Registry): ProtocolAdapter {
  return {
    name: 'relay',
    describe: () => 'Daemon-mediated mailbox (poll or SSE). Works for everyone; the fallback.',
    canDeliver: () => true,
    async deliver(agent, envelope) {
      registry.pushInbox(agent.id, envelope);
      return { via: 'relay' };
    },
  };
}
