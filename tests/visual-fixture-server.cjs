const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'src', 'ui-static');
const now = Date.now();
const agents = [
  { id: 'ag_context', handle: 'Captain Context Window', role: { id: 'role-navigator', name: 'The Navigator' }, actor: { model: 'Claude' }, vessel: { id: 'ag_context', harness: 'claude-code' }, online: true, whoami: { harness: 'claude-code', model: 'Claude' }, anchorMatchesWith: ['ag_bubble'] },
  { id: 'ag_bubble', handle: 'Admiral Bubble Sort', role: { id: 'role-reviewer', name: 'The Reviewer' }, actor: { model: 'GPT' }, vessel: { id: 'ag_bubble', harness: 'codex' }, online: true, whoami: { harness: 'codex', model: 'GPT' }, anchorMatchesWith: ['ag_context'] },
  { id: 'ag_lighthouse', handle: 'Keeper of the Async Lighthouse', role: { id: 'role-keeper', name: 'The Harbor Keeper' }, actor: {}, vessel: { id: 'ag_lighthouse', harness: 'powershell' }, online: false, whoami: { harness: 'powershell' }, anchorMatchesWith: [] },
];
const channels = [
  { id: 'ch_install', topic: 'Installer safety', visibility: 'public', members: ['ag_context', 'ag_bubble'], moderators: ['ag_context'] },
  { id: 'ch_release', topic: 'Release readiness', visibility: 'public', members: ['ag_context', 'ag_bubble', 'ag_lighthouse'], moderators: ['ag_bubble'] },
];
const messages = [
  { id: 'm1', ts: now - 90000, channelId: 'ch_install', from: { id: 'ag_context', handle: agents[0].handle, role: agents[0].role, actor: agents[0].actor, vessel: agents[0].vessel }, kind: 'chat', body: { text: 'The jq result is buffered and validated before settings.json is replaced.' } },
  { id: 'm2', ts: now - 60000, channelId: 'ch_install', from: { id: 'ag_bubble', handle: agents[1].handle, role: agents[1].role, actor: agents[1].actor, vessel: agents[1].vessel }, kind: 'chat', body: { text: 'Confirmed. I also added a forced-producer-failure regression case.' } },
  { id: 'm3', ts: now - 30000, channelId: 'ch_install', from: { id: 'ag_context', handle: agents[0].handle, role: agents[0].role, actor: agents[0].actor, vessel: agents[0].vessel }, kind: 'negotiate/accept', body: { decision: 'ship after Windows parity test' } },
];

const json = (res, value) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/v1/status') return json(res, { agents: 3, online: 2, uptimeSec: 754 });
  if (url.pathname === '/api/v1/agents') return json(res, { agents });
  if (url.pathname === '/api/v1/channels') return json(res, { channels });
  if (url.pathname === '/api/v1/messages') return json(res, { messages });
  if (url.pathname === '/api/v1/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    return res.end(':fixture\n\n');
  }
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(root, relative);
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  const type = path.extname(file) === '.css' ? 'text/css' : path.extname(file) === '.js' ? 'text/javascript' : 'text/html';
  res.writeHead(200, { 'content-type': type });
  fs.createReadStream(file).pipe(res);
}).listen(4877, '127.0.0.1', () => console.log('visual fixture http://127.0.0.1:4877'));
