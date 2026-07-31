// GitLab anchor provider. Same idea as GitHub, but the anchor lives in a
// private snippet titled "portcall-anchor-v1". Credentials from GITLAB_TOKEN
// (or `glab auth token` if the glab CLI is around). Host override via
// GITLAB_HOST for self-managed instances.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import type { IdentityProvider } from '../types.ts';

const ANCHOR_TITLE = 'portcall-anchor-v1';

let cachedToken: string | null = null;
let cachedAnchor: string | null = null;

function apiBase(): string {
  const host = (process.env.GITLAB_HOST || 'gitlab.com').replace(/^https?:\/\//, '');
  return `https://${host}/api/v4`;
}

function token(): string {
  if (cachedToken) return cachedToken;
  const fromEnv = process.env.GITLAB_TOKEN;
  if (fromEnv) return (cachedToken = fromEnv.trim());
  for (const bin of ['glab', 'glab.exe']) {
    try {
      const out = execFileSync(bin, ['auth', 'token'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (out) return (cachedToken = out);
    } catch { /* try next */ }
  }
  throw new Error('No GitLab credentials found. Set GITLAB_TOKEN (api scope) or log in with `glab auth login`.');
}

async function gl(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(apiBase() + path, {
    ...init,
    headers: {
      'private-token': token(),
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`GitLab API ${path} -> ${res.status}: ${await res.text()}`);
  return res;
}

export const gitlabProvider: IdentityProvider = {
  name: 'gitlab',
  describe: () =>
    'Anchor secret in a private GitLab snippet (portcall-anchor-v1); creds via GITLAB_TOKEN or glab CLI.',

  async getAnchor() {
    if (cachedAnchor) return cachedAnchor;
    const snippets = (await (await gl('/snippets?per_page=100')).json()) as {
      id: number;
      title: string;
    }[];
    const existing = snippets.find((s) => s.title === ANCHOR_TITLE);
    if (existing) {
      const raw = (await (await gl(`/snippets/${existing.id}/raw`)).text()).trim();
      if (!raw) throw new Error(`Anchor snippet ${existing.id} is empty.`);
      return (cachedAnchor = raw);
    }
    const secret = crypto.randomBytes(32).toString('hex');
    await gl('/snippets', {
      method: 'POST',
      body: JSON.stringify({
        title: ANCHOR_TITLE,
        visibility: 'private',
        files: [{ file_path: 'anchor.secret', content: secret }],
      }),
    });
    return (cachedAnchor = secret);
  },

  async anchoredTo() {
    const user = (await (await gl('/user')).json()) as { username: string };
    return `${(process.env.GITLAB_HOST || 'gitlab.com').replace(/^https?:\/\//, '')}/${user.username}`;
  },
};
