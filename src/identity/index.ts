// Identity providers: where the "anchor" secret lives. The anchor is a random
// secret stored somewhere ONLY the owner's credentials can read (a private
// gist, a private snippet). Any agent that can fetch it is, by construction,
// under the owner's control — that fact powers the Flag Check handshake.

import type { IdentityProvider } from '../types.ts';
import { githubProvider } from './github.ts';
import { gitlabProvider } from './gitlab.ts';

const providers = new Map<string, IdentityProvider>([
  ['github', githubProvider],
  ['gitlab', gitlabProvider],
]);

export function getProvider(name: string): IdentityProvider {
  const p = providers.get(name);
  if (!p) {
    throw new Error(
      `Unknown identity provider "${name}". Known: ${[...providers.keys()].join(', ')}`,
    );
  }
  return p;
}

export function registerProvider(provider: IdentityProvider): void {
  providers.set(provider.name, provider);
}

export function listProviders(): { name: string; about: string }[] {
  return [...providers.values()].map((p) => ({ name: p.name, about: p.describe() }));
}
