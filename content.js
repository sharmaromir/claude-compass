(function () {
  'use strict';
  if (document.getElementById('compass-root')) return;
  const C = globalThis.Compass;
  const A = globalThis.CompassAdapter;
  let state = C.defaultState();
  let current = null;
  let lastActivityAt = Date.now();
  let agentFingerprint = '';
  let observerTimer;
  let disconnected = false;
  let busy = false;
  let heartbeatPending = false;
  let timing = null;
  let latestSnapshot = null;
  const retiredEpochs = new Set();
  let requestSequence = 0;
  let minimumAcceptedRequest = 0;
  let lastHeartbeatAttempt = 0;
  let handshakeBlockedUntil = 0;
  let refreshPending = false;
  let refreshQueued = false;
  let suspendProjection = false;
  let lastPaintAt = Date.now();
  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  const host = document.createElement('div');
  host.id = 'compass-root';
  const shadow = host.attachShadow({mode: 'open'});
  shadow.innerHTML = `<style>
    :host {all:initial;--accent:#8671c9;--surface:#fcfbf8;--inset:#f3f2ee;--text:#24262c;--muted:#737570;--border:#e2e1da;--button:#fff;--hover:#efeee8;font-family:system-ui,sans-serif;color-scheme:light}
    :host([data-theme=dark]) {--surface:#181b20;--inset:#22262c;--text:#edf0f3;--muted:#a4abb5;--border:#343a43;--button:#242930;--hover:#303741;color-scheme:dark}
    *{box-sizing:border-box} button,input{font:inherit} button{cursor:pointer} button:disabled,input:disabled{opacity:.45;cursor:default}
    .panel{width:284px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-top:3px solid var(--accent);border-radius:16px;box-shadow:0 12px 32px #00000020;overflow:hidden;font-size:12px}
    .head{display:flex;align-items:center;gap:10px;padding:14px 14px 12px}.identity{flex:1;min-width:0}
    .eyebrow{color:var(--muted);font-size:9px;font-weight:650;letter-spacing:.12em;text-transform:uppercase;margin-bottom:4px}
    .title{font-size:12px;font-weight:650;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .dot{width:10px;height:10px;flex:none;background:var(--accent);border-radius:50%;box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 12%,transparent)}
    .toggle{width:26px;height:26px;flex:none;display:grid;place-items:center;border:0;background:transparent;color:var(--muted);border-radius:7px;font-size:17px;padding:0}.toggle:hover{background:var(--hover)}
    .body{padding:0 12px 12px}.body[hidden]{display:none}.times{display:grid;grid-template-columns:1fr 1fr;gap:8px}.time-box{padding:11px 10px 10px;border:1px solid var(--border);background:var(--inset);border-radius:10px}
    .stat{display:block;font:600 17px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;font-variant-numeric:tabular-nums;letter-spacing:-.04em;white-space:nowrap}.label{display:block;font-size:10px;color:var(--muted);margin-top:5px;font-weight:450}
    .status{color:var(--muted);font-size:10px;line-height:1.5;min-height:15px;margin:11px 2px;display:flex;align-items:center;gap:6px}.status::before{content:'';width:5px;height:5px;flex:none;border-radius:50%;background:var(--muted)}.status[data-status=active]::before{background:#56ad83}.status[data-status=idle]::before{background:#d7a657}
    .actions{display:grid;grid-template-columns:32px 1fr 1fr;gap:7px;align-items:center}.actions button{height:32px;padding:0 8px;border-radius:8px;border:1px solid var(--border);background:var(--button);color:var(--text);font-size:10px;font-weight:550;white-space:nowrap}.actions button:hover:enabled{background:var(--hover)}
    input[type=color]{width:32px;height:32px;border:1px solid var(--border);border-radius:8px;padding:5px;background:var(--button);cursor:pointer}input[type=color]::-webkit-color-swatch-wrapper{padding:0}input[type=color]::-webkit-color-swatch{border:0;border-radius:4px}
    .notice{font-size:10px;margin:9px 2px 0;color:var(--muted);line-height:1.5}.notice:empty{display:none}
    button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    @media(max-width:760px){.panel{width:258px}.stat{font-size:15px}.head{padding:12px}.actions{gap:5px}}
  </style><section class="panel" aria-label="Claude Compass chat identity">
    <div class="head"><span class="dot"></span><div class="identity"><div class="eyebrow">Claude Compass</div><div class="title">Open a saved chat</div></div><button class="toggle" aria-label="Collapse Compass" aria-expanded="true">−</button></div>
    <div class="body"><div class="times"><div class="time-box"><span class="stat active">00:00:00</span><span class="label">Active today</span></div><div class="time-box"><span class="stat idle">00:00:00</span><span class="label">Idle today</span></div></div><div class="status" aria-live="polite"></div><div class="actions"><input type="color" aria-label="Chat identity color" title="Choose this chat’s color"><button class="copy">Copy update</button><button class="mail">Mailbox</button></div><div class="notice" aria-live="polite"></div></div>
  </section>`;
  const $ = sel => shadow.querySelector(sel);
  const edge = document.createElement('div');
  edge.id = 'compass-edge';
  document.documentElement.append(edge);
  document.documentElement.append(host);
  const label = document.createElement('div');
  label.id = 'compass-composer-label';

  async function send(message) {
    if (disconnected) return null;
    const requestId = ++requestSequence;
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (!response?.ok) throw new Error(response?.error || 'Extension unavailable');
      if (response.state && requestId >= minimumAcceptedRequest && C.newerSnapshot(response.snapshot, latestSnapshot, retiredEpochs)) {
        if (latestSnapshot && latestSnapshot.epoch !== response.snapshot.epoch) retiredEpochs.add(latestSnapshot.epoch);
        state = response.state;
        timing = response.timing;
        latestSnapshot = response.snapshot;
        suspendProjection = false;
      }
      return response;
    } catch (error) {
      if (/context invalidated|receiving end|extension unavailable/i.test(error.message)) disconnected = true;
      timing = null;
      $('.notice').textContent = disconnected ? 'Extension updated. Reload this page to reconnect.' : error.message;
      return null;
    }
  }

  function needsTimingHandshake() {
    const record = current && state.chats[current.id];
    return current && !state.settings.paused && document.visibilityState === 'visible' && document.hasFocus() &&
      (!timing || !timing.ownedBySender || !timing.visible || !timing.focused || timing.chatId !== current.id || timing.chatCreatedAt !== record?.createdAt);
  }

  function applyTheme() {
    const preference = state.settings.theme || 'system';
    host.dataset.themePreference = preference;
    host.dataset.theme = preference === 'system' ? systemTheme.matches ? 'dark' : 'light' : preference;
    label.dataset.theme = host.dataset.theme;
  }

  function refreshTimer(now = Date.now()) {
    if (suspendProjection) return;
    const record = current && state.chats[current.id];
    const foreground = document.visibilityState === 'visible' && document.hasFocus();
    const routeMatches = C.chatFromUrl(location.href)?.id === current?.id;
    const projected = C.projectChat(record, timing, now, state.settings, {
      owned: timing?.ownedBySender === true && routeMatches && !disconnected,
      visible: document.visibilityState === 'visible', focused: document.hasFocus(), lastActivityAt
    });
    const today = projected?.days[C.dayKey(now)] || {activeMs:0,idleMs:0};
    const activeClock = C.formatClock(today.activeMs);
    const idleClock = C.formatClock(today.idleMs);
    if ($('.active').textContent !== activeClock) $('.active').textContent = activeClock;
    if ($('.idle').textContent !== idleClock) $('.idle').textContent = idleClock;
    const idle = now - lastActivityAt >= state.settings.idleSeconds * 1000;
    const status = !current ? 'new' : state.settings.paused ? 'paused' : !foreground ? 'away' : idle ? 'idle' : 'active';
    if ($('.status').dataset.status !== status) $('.status').dataset.status = status;
    const statusText = {new:'Tracking starts when this chat has a URL.',paused:'Tracking paused',away:'Away · tracking paused',idle:'Idle · no recent interaction',active:'Active · focused on this chat'}[status];
    if ($('.status').textContent !== statusText) $('.status').textContent = statusText;
  }

  async function refreshFromWorker() {
    if (refreshPending) { refreshQueued = true; return; }
    refreshPending = true;
    do {
      refreshQueued = false;
      await send({type:'GET_STATE'});
      refreshIdentity();
    } while (refreshQueued && !disconnected);
    refreshPending = false;
  }

  function refreshIdentity() {
    applyTheme();
    const record = current && state.chats[current.id];
    const color = record?.color || (current ? C.colorForId(current.id) : '#8c8b85');
    const title = record?.title || current?.title || 'Open a saved chat';
    host.style.setProperty('--accent', color);
    document.documentElement.style.setProperty('--compass-color', color);
    $('.title').textContent = title;
    $('.title').title = title;
    $('input').value = color;
    $('input').disabled = !current;
    $('.copy').disabled = !current;
    refreshTimer();
    const unread = Object.values(state.agents).filter(a => a.chatId === current?.id && !a.read && ['completed', 'failed'].includes(a.status)).length;
    $('.mail').textContent = unread ? `Mailbox (${unread})` : 'Mailbox';
    label.textContent = current ? `Sending to: ${title}` : 'New chat · color assigned when saved';
    edge.hidden = !current;
    decorate();
  }

  function decorate() {
    for (const link of document.querySelectorAll('a[href]')) {
      const chat = C.chatFromUrl(link.href);
      if (!chat) {
        if (link.hasAttribute('data-compass-chat')) {
          link.removeAttribute('data-compass-chat');
          link.style.removeProperty('--compass-link-color');
        }
        continue;
      }
      // Limit to navigation UI, so references to other chats in a message are left alone.
      if (!link.closest('nav, aside, [data-testid*="sidebar"], [aria-label*="Sidebar"], [aria-label*="sidebar"]')) continue;
      const color = state.chats[chat.id]?.color || C.colorForId(chat.id);
      if (link.dataset.compassChat !== chat.id) link.dataset.compassChat = chat.id;
      if (link.style.getPropertyValue('--compass-link-color') !== color) link.style.setProperty('--compass-link-color', color);
    }
    const editor = A.composer();
    const shell = A.composerShell(editor);
    for (const old of document.querySelectorAll('[data-compass-composer]')) if (old !== shell) old.removeAttribute('data-compass-composer');
    if (shell && !shell.hasAttribute('data-compass-composer')) shell.setAttribute('data-compass-composer', '');
    if (editor) {
      // Claude positions the placeholder at the top of this wrapper. A label
      // before the editor would collide with it; keep the cue below the editor.
      if (label.previousSibling !== editor) editor.after(label);
    } else label.remove();
  }

  async function heartbeat() {
    if (disconnected) return;
    if (busy) { heartbeatPending = true; return; }
    busy = true;
    const next = A.currentChat();
    const changed = next?.id !== current?.id;
    current = next;
    if (changed) { agentFingerprint = ''; timing = null; }
    const at = Date.now();
    lastHeartbeatAttempt = at;
    const response = await send({type: 'HEARTBEAT', chat: current, at, lastActivityAt, visible: document.visibilityState === 'visible', focused: document.hasFocus()});
    handshakeBlockedUntil = response?.foregroundEligible === false ? Date.now() + 1000 : 0;
    busy = false;
    refreshIdentity();
    if (heartbeatPending) { heartbeatPending = false; await heartbeat(); }
  }

  async function scan() {
    if (busy) return;
    const next = A.currentChat();
    if (next?.id !== current?.id || (next && next.title !== current?.title)) await heartbeat();
    decorate();
    if (!current || disconnected) return;
    const agents = A.agents();
    const fingerprint = current.id + JSON.stringify(agents);
    if (fingerprint !== agentFingerprint && agents.length) {
      const response = await send({type:'AGENTS_OBSERVED',chatId:current.id,agents});
      if (response) agentFingerprint = fingerprint;
      refreshIdentity();
    }
  }

  function activity(event) {
    if (!event.isTrusted) return;
    const now = Date.now();
    const wasIdle = now - lastActivityAt >= state.settings.idleSeconds * 1000;
    // The worker splits the interval at this timestamp; earlier idle stays idle.
    lastActivityAt = now;
    if (wasIdle || needsTimingHandshake()) { refreshTimer(now); heartbeat(); }
  }
  for (const name of ['pointerdown','pointermove','keydown','wheel','touchstart']) window.addEventListener(name, activity, {capture:true,passive:true});
  const foregroundChanged = () => { suspendProjection = true; heartbeat(); };
  window.addEventListener('focus', () => { lastActivityAt = Date.now(); foregroundChanged(); });
  window.addEventListener('blur', foregroundChanged);
  window.addEventListener('pagehide', foregroundChanged);
  document.addEventListener('visibilitychange', foregroundChanged);
  window.addEventListener('popstate', scan);
  $('.toggle').addEventListener('click', () => {
    const hidden = !$('.body').hidden;
    $('.body').hidden = hidden;
    $('.toggle').textContent = hidden ? '+' : '−';
    $('.toggle').setAttribute('aria-expanded', String(!hidden));
    $('.toggle').setAttribute('aria-label', hidden ? 'Expand Compass' : 'Collapse Compass');
  });
  $('input').addEventListener('change', async event => {
    if (current) { await send({type:'SET_COLOR',chatId:current.id,color:event.target.value}); refreshIdentity(); }
  });
  $('.mail').addEventListener('click', () => send({type:'OPEN_DASHBOARD',chatId:current?.id}));
  $('.copy').addEventListener('click', async () => {
    if (!current) return;
    try {
      const chat = state.chats[current.id];
      await navigator.clipboard.writeText(C.summarizeChat(chat));
      $('.notice').textContent = 'Update copied. Paste it wherever you need.';
      await send({type:'CREATE_REPORT',chatId:current.id});
    } catch (_) { $('.notice').textContent = 'Clipboard unavailable. Open the dashboard to select and copy your update.'; }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.compassState?.newValue) return;
    const incoming = changes.compassState.newValue;
    // A response already in flight predates this commit. Only a newly requested
    // paired snapshot may replace it (especially after reset or deletion).
    minimumAcceptedRequest = requestSequence + 1;
    const timingSettingsChanged = incoming.settings.paused !== state.settings.paused || incoming.settings.idleSeconds !== state.settings.idleSeconds;
    // Never combine newly persisted totals with an older timing checkpoint.
    // Reset/deletion is immediate; other changes get an atomic worker snapshot.
    if (current && !incoming.chats[current.id]) { state = incoming; timing = null; refreshIdentity(); }
    if (incoming.settings.paused && !state.settings.paused) suspendProjection = true;
    refreshFromWorker();
    if (timingSettingsChanged) heartbeat();
  });
  systemTheme.addEventListener('change', applyTheme);
  new MutationObserver(records => {
    if (!records.some(r => ![host, edge, label].includes(r.target) && !host.contains(r.target) && !label.contains(r.target))) return;
    clearTimeout(observerTimer);
    observerTimer = setTimeout(scan, 400);
  }).observe(document.body, {childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['data-agent-status','data-status','data-agent-result','data-agent-id']});
  setInterval(() => { heartbeat().then(scan); }, 5000);
  setInterval(() => { if (A.currentChat()?.id !== current?.id) heartbeat().then(scan); }, 1000);
  setInterval(() => {
    const now = Date.now();
    if (now - lastPaintAt > C.MAX_HEARTBEAT_GAP_MS || now < lastPaintAt) { timing = null; lastActivityAt = Math.min(lastActivityAt, now); heartbeat(); }
    lastPaintAt = now;
    if (!busy && !refreshPending && now >= handshakeBlockedUntil && now - lastHeartbeatAttempt >= 250 && needsTimingHandshake()) heartbeat();
    refreshTimer(now);
  }, 250);
  applyTheme();
  send({type:'GET_STATE'}).then(heartbeat).then(scan);
})();
