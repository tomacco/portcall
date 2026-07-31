// Harbor Master's Glass — watches the daemon over SSE, redraws the roster on
// crew events, appends signal traffic live.

const $ = (id) => document.getElementById(id);
let msgCount = 0;

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}

async function refreshStatus() {
  try {
    const s = await (await fetch('/api/v1/status')).json();
    $('daemon-pip').classList.add('up');
    $('status-text').textContent =
      `anchored to ${s.anchoredTo ?? s.identityProvider ?? 'nothing'} · ` +
      `${s.online}/${s.agents} aboard · up ${Math.floor(s.uptimeSec / 60)}m`;
  } catch {
    $('daemon-pip').classList.remove('up');
    $('status-text').textContent = 'daemon unreachable — is portcalld running?';
  }
}

async function refreshRoster() {
  try {
    const { agents } = await (await fetch('/api/v1/agents')).json();
    $('crew-count').textContent = agents.filter((a) => a.online).length;
    const roster = $('roster');
    if (!agents.length) {
      roster.innerHTML = '<div class="empty">The harbor is quiet. No sails on the horizon.<br>Send an agent to <code>/api/v1/agents</code>.</div>';
      return;
    }
    roster.innerHTML = agents
      .map((a) => {
        const verified = a.verifiedWith.length
          ? `<span class="badge verified">⚑ flag checked ×${a.verifiedWith.length}</span>`
          : '<span class="badge unverified">unverified</span>';
        return `
        <div class="crew-card ${a.online ? 'online' : 'gone'}" data-id="${esc(a.id)}">
          <div class="crew-name">${esc(a.handle ?? a.id)} ${verified}</div>
          <div class="crew-whoami">
            <b>who</b> ${esc(a.whoami.harness)}${a.whoami.model ? ' · ' + esc(a.whoami.model) : ''}<br>
            <b>owner</b> ${esc(a.whoami.owner)}<br>
            <b>purpose</b> ${esc(a.whoami.purpose)}<br>
            <b>speaks</b> ${esc(a.protocols.join(', ') || 'relay')} · <b>id</b> ${esc(a.id)}
          </div>
        </div>`;
      })
      .join('');
  } catch { /* daemon will come back */ }
}

function kindClass(kind) {
  if (kind.startsWith('hs/')) return 'kind-hs';
  if (kind.startsWith('negotiate/')) return 'kind-negotiate';
  if (kind === 'chat') return 'kind-chat';
  return 'kind-system';
}

function appendLog(kind, html) {
  const log = $('log');
  const empty = log.querySelector('.empty');
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = 'entry';
  const ts = new Date().toLocaleTimeString([], { hour12: false });
  el.innerHTML = `<span class="ts">${ts}</span><span class="kind ${kindClass(kind)}">${esc(kind)}</span><span class="what">${html}</span>`;
  log.appendChild(el);
  while (log.children.length > 400) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
  $('msg-count').textContent = ++msgCount;
}

function nameOf(ref) {
  return `<span class="who">${esc(ref?.handle ?? ref?.id ?? '?')}</span>`;
}

function watch() {
  const es = new EventSource('/api/v1/events');
  es.addEventListener('agent:joined', (e) => {
    const a = JSON.parse(e.data);
    appendLog('system', `${nameOf(a)} sails into harbor <span class="arrow">(${esc(a.whoami.harness)}, ${esc(a.whoami.purpose)})</span>`);
    refreshRoster();
  });
  es.addEventListener('agent:left', (e) => {
    const a = JSON.parse(e.data);
    appendLog('system', `${nameOf(a)} weighs anchor and departs`);
    refreshRoster();
  });
  es.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    const to = `<span class="who">${esc(m.to)}</span>`;
    let detail = '';
    if (m.kind === 'chat' && m.body?.text) detail = ` — “${esc(m.body.text)}”`;
    else if (m.kind.startsWith('hs/')) detail = ' <span class="arrow">(flag check in progress)</span>';
    else if (m.body && Object.keys(m.body).length) detail = ` <span class="arrow">${esc(JSON.stringify(m.body).slice(0, 120))}</span>`;
    appendLog(m.kind, `${nameOf(m.from)} <span class="arrow">→</span> ${to}${detail} <span class="arrow">via ${esc(m.via ?? '?')}</span>`);
  });
  es.addEventListener('handshake', (e) => {
    const h = JSON.parse(e.data);
    if (h.verified) {
      appendLog('hs/verified', `<span class="verified-note">⚑ FLAG CHECK PASSED</span> — ${esc(h.pair[0])} and ${esc(h.pair[1])} sail under the same flag`);
    }
    refreshRoster();
  });
  es.onerror = () => refreshStatus();
  es.onopen = () => refreshStatus();
}

$('log').innerHTML = '<div class="empty">No signals yet. The sea is calm.</div>';
refreshStatus();
refreshRoster();
watch();
setInterval(refreshStatus, 10_000);
setInterval(refreshRoster, 15_000);
