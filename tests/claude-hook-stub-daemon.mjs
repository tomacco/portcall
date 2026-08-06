// Minimal PortCall stub for hook heartbeat-policy tests. Heartbeat status is
// scripted via argv; every registration is counted into the file at argv[4].
//
//   node claude-hook-stub-daemon.mjs <port> <heartbeat-status> <reg-count-file>
import http from 'node:http';
import fs from 'node:fs';

const [port, hbStatus, regFile] = process.argv.slice(2);
let regs = 0;
let heartbeats = 0;

http.createServer((req, res) => {
  const j = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url.startsWith('/api/v1/names/suggest')) return j(200, { suggestions: ['Stub Handle'] });
  if (req.method === 'POST' && req.url === '/api/v1/agents') {
    regs += 1;
    fs.writeFileSync(regFile, String(regs));
    return j(201, { id: 'ag_new' + regs, token: 'tok_new' + regs, agent: { handle: 'Stub Handle' } });
  }
  if (req.method === 'POST' && /\/heartbeat$/.test(req.url)) {
    heartbeats += 1;
    fs.writeFileSync(regFile + '.hb', String(heartbeats));
    return j(Number(hbStatus), { ok: hbStatus === '200' });
  }
  if (/\/inbox$/.test(req.url)) return j(200, { envelopes: [] });
  j(404, { error: 'nope' });
}).listen(Number(port), '127.0.0.1', () => console.log('ready'));
