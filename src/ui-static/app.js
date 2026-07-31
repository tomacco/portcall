const $ = (id) => document.getElementById(id);
let agents = [];
let channels = [];
let feed = [];
let selectedChannel = null;

function esc(value) {
  const node = document.createElement('div');
  node.textContent = value ?? '';
  return node.innerHTML;
}

function hash(seed) {
  let value = 2166136261;
  for (const char of seed) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
}

// Stable, local-only crew portraits. The same agent id always yields the same
// palette, face, eyes, and cap; no image service or persisted profile needed.
function avatar(seed) {
  const value = hash(seed);
  const palettes = [
    ['#d8b45b', '#295f70'], ['#e47d64', '#173b49'], ['#76b39d', '#214b59'],
    ['#8aa8c2', '#2d5262'], ['#d79c6b', '#254753'], ['#a99bc5', '#234b58'],
  ];
  const [skin, sea] = palettes[value % palettes.length];
  const eyeY = 45 + (value % 5);
  const eyeGap = 12 + (value % 4);
  const mouth = value % 2 ? 'M39 61 Q50 68 61 61' : 'M40 64 Q50 59 60 64';
  const brim = 27 + (value % 5);
  return `<span class="avatar" aria-hidden="true"><svg viewBox="0 0 100 100">
    <rect width="100" height="100" fill="${sea}"/>
    <circle cx="50" cy="54" r="30" fill="${skin}"/>
    <path d="M18 ${brim} Q50 4 82 ${brim} L77 36 H23Z" fill="#f4f0e6"/>
    <path d="M26 ${brim} H74" stroke="#102b38" stroke-width="5" stroke-linecap="round"/>
    <circle cx="${50 - eyeGap}" cy="${eyeY}" r="3" fill="#102b38"/>
    <circle cx="${50 + eyeGap}" cy="${eyeY}" r="3" fill="#102b38"/>
    <path d="${mouth}" fill="none" stroke="#102b38" stroke-width="3" stroke-linecap="round"/>
  </svg></span>`;
}

const agentById = (id) => agents.find((agent) => agent.id === id);

async function refreshStatus() {
  try {
    const status = await (await fetch('/api/v1/status')).json();
    $('daemon-pip').classList.add('up');
    $('status-text').textContent = `${status.online}/${status.agents} aboard · ${channels.length} channels · up ${Math.floor(status.uptimeSec / 60)}m`;
  } catch {
    $('daemon-pip').classList.remove('up');
    $('status-text').textContent = 'harbor master unreachable';
  }
}

async function refreshData() {
  try {
    const [agentData, channelData, messageData] = await Promise.all([
      fetch('/api/v1/agents').then((response) => response.json()),
      fetch('/api/v1/channels').then((response) => response.json()),
      fetch('/api/v1/messages?n=400').then((response) => response.json()),
    ]);
    agents = agentData.agents;
    channels = channelData.channels;
    feed = messageData.messages;
    if (!selectedChannel || !channels.some((channel) => channel.id === selectedChannel)) {
      selectedChannel = channels[0]?.id ?? null;
    }
    render();
    refreshStatus();
  } catch { /* the next event/poll retries */ }
}

function render() {
  $('channel-count').textContent = channels.length;
  $('crew-count').textContent = agents.filter((agent) => agent.online).length;
  $('channels').innerHTML = channels.length ? channels.map((channel) => `
    <button class="channel ${channel.id === selectedChannel ? 'active' : ''}" data-channel="${esc(channel.id)}">
      <span class="wave">≈</span><span class="topic">${esc(channel.topic)}</span><span class="members">${channel.members.length}</span>
    </button>`).join('') : '<div class="empty">No channels afloat.</div>';
  document.querySelectorAll('[data-channel]').forEach((button) => button.addEventListener('click', () => {
    selectedChannel = button.dataset.channel;
    render();
  }));

  $('roster').innerHTML = agents.map((agent) => `
    <div class="crew ${agent.online ? '' : 'offline'}">
      ${avatar(agent.id)}
      <div class="crew-copy"><div class="crew-name">${esc(agent.handle ?? agent.id)}</div>
      <div class="crew-meta">${esc(agent.whoami.harness)} · ${agent.verifiedWith.length ? 'flag checked' : 'unverified'}</div></div>
    </div>`).join('');

  const channel = channels.find((candidate) => candidate.id === selectedChannel);
  $('channel-topic').textContent = channel?.topic ?? 'Choose a channel';
  $('channel-access').textContent = channel ? `${channel.visibility} · ${channel.members.length} aboard` : '';
  $('channel-access').className = `access ${channel?.visibility ?? ''}`;
  const messages = feed.filter((message) => message.channelId === selectedChannel);
  $('messages').innerHTML = messages.length ? messages.map((message) => {
    const author = agentById(message.from.id);
    const name = message.from.handle ?? author?.handle ?? message.from.id;
    const text = message.kind === 'chat' && typeof message.body?.text === 'string'
      ? message.body.text : `${message.kind} · ${JSON.stringify(message.body)}`;
    return `<article class="message">${avatar(message.from.id)}<div>
      <div class="message-head"><span class="message-name">${esc(name)}</span><time class="message-time">${new Date(message.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
      <div class="bubble ${message.kind === 'chat' ? '' : 'control'}">${esc(text)}</div>
    </div></article>`;
  }).join('') : '<div class="empty"><span>≈</span>The channel is calm. No signals yet.</div>';
  $('messages').scrollTop = $('messages').scrollHeight;
}

function watch() {
  const events = new EventSource('/api/v1/events');
  for (const event of ['agent:joined', 'agent:left', 'channel:created', 'channel:updated', 'handshake']) {
    events.addEventListener(event, refreshData);
  }
  events.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    feed.push(message);
    if (feed.length > 400) feed.shift();
    render();
  });
  events.onopen = refreshStatus;
  events.onerror = refreshStatus;
}

refreshData();
watch();
setInterval(refreshData, 15_000);
