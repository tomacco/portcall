// GitHub anchor provider. The anchor lives in a PRIVATE gist named
// "portcall-anchor-v1". First caller creates it; everyone with the owner's
// GitHub credentials (env token or `gh` CLI, including gh.exe via WSL
// interop) fetches the same one. Nobody else can.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import type { IdentityProvider } from '../types.ts';

const ANCHOR_DESC = 'portcall-anchor-v1';
const API = 'https://api.github.com';

let cachedToken: string | null = null;
let cachedAnchor: string | null = null;

function token(): string {
  if (cachedToken) return cachedToken;
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return (cachedToken = fromEnv.trim());
  for (const bin of ['gh', 'gh.exe']) {
    try {
      const out = execFileSync(bin, ['auth', 'token'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (out) return (cachedToken = out);
    } catch { /* try next */ }
  }
  throw new Error(
    'No GitHub credentials found. Set GITHUB_TOKEN, or log in with `gh auth login` (needs the gist scope).',
  );
}

async function gh(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(API + path, {
    ...init,
    headers: {
      authorization: `Bearer ${token()}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'portcall',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${path} -> ${res.status}: ${await res.text()}`);
  return res;
}

interface GistSummary {
  id: string;
  description: string;
  public: boolean;
  files: Record<string, { filename: string; content?: string }>;
}

export const githubProvider: IdentityProvider = {
  name: 'github',
  describe: () =>
    'Anchor secret in a private GitHub gist (portcall-anchor-v1); creds via GITHUB_TOKEN or gh CLI.',

  async getAnchor() {
    if (cachedAnchor) return cachedAnchor;
    const gists = (await (await gh('/gists?per_page=100')).json()) as GistSummary[];
    const existing = gists.find((g) => g.description === ANCHOR_DESC && !g.public);
    if (existing) {
      const raw = (await (await gh(`/gists/${existing.id}`)).json()) as GistSummary;
      const content = Object.values(raw.files)[0]?.content?.trim();
      if (!content) throw new Error(`Anchor gist ${existing.id} is empty.`);
      return (cachedAnchor = content);
    }
    const secret = crypto.randomBytes(32).toString('hex');
    await gh('/gists', {
      method: 'POST',
      body: JSON.stringify({
        description: ANCHOR_DESC,
        public: false,
        files: { 'anchor.secret': { content: secret } },
      }),
    });
    return (cachedAnchor = secret);
  },

  async anchoredTo() {
    const user = (await (await gh('/user')).json()) as { login: string };
    return `github.com/${user.login}`;
  },
};
