/* Apply appearance before the stylesheet paints; the saved state remains authoritative. */
(() => {
  const params = new URLSearchParams(location.search);
  const demo = params.get('demo') === '1';
  const media = matchMedia('(prefers-color-scheme: dark)');
  const valid = (value) => ['system', 'light', 'dark'].includes(value) ? value : 'system';
  let preference = 'system';
  if (demo) preference = valid(params.get('theme'));
  else { try { preference = valid(localStorage.getItem('compassAppearance')); } catch { /* Storage may be unavailable in a file preview. */ } }
  function apply(value, remember = false) {
    preference = valid(value);
    document.documentElement.dataset.themePreference = preference;
    document.documentElement.dataset.theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    if (remember && !demo) { try { localStorage.setItem('compassAppearance', preference); } catch { /* The main extension setting is still persisted. */ } }
  }
  media.addEventListener('change', () => apply(preference));
  globalThis.CompassAppearance = { apply };
  apply(preference);
})();

/* Claude Compass dashboard. Local extension data never leaves this page. */
document.addEventListener('DOMContentLoaded', () => {
  'use strict';
  const DEMO = new URLSearchParams(location.search).get('demo') === '1';
  const $ = (id) => document.getElementById(id);
  const C = globalThis.Compass;
  let state = C.defaultState();
  let page = 'overview';
  let settingsDirty = false;
  let themePreview = null;
  let toastTimer;
  let selectedChat = '';
  let agentFingerprint = '';
  try { selectedChat = decodeURIComponent(location.hash.slice(1)); } catch { /* Ignore invalid fragments. */ }

  function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = String(text);
    return item;
  }
  function action(label, className, fn, title) {
    const item = node('button', className || 'button', label);
    item.type = 'button';
    if (title) { item.title = title; if (label === '×') item.setAttribute('aria-label', title); }
    item.addEventListener('click', () => run(fn, item));
    return item;
  }
  function safeColor(color, id) { return /^#[\da-f]{6}$/i.test(color || '') ? color : C.colorForId(id || 'compass'); }
  function safeUrl(url) {
    try { const parsed = new URL(url); return parsed.protocol === 'https:' && ['claude.ai', 'www.claude.ai'].includes(parsed.hostname) ? parsed.href : null; } catch { return null; }
  }
  function dateText(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Not recorded' : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function duration(value) { return C.formatDuration(Math.max(0, Number(value) || 0)); }
  function chatName(id) { return state.chats[id]?.title || (id === 'manual-session' ? 'Unassigned session' : 'Conversation unavailable'); }
  function todayTotals(chat) { return chat.days?.[C.dayKey(new Date())] || { activeMs: 0, idleMs: 0 }; }
  function totalsForToday() {
    return Object.values(state.chats).reduce((sum, chat) => { const day = todayTotals(chat); sum.activeMs += Number(day.activeMs) || 0; sum.idleMs += Number(day.idleMs) || 0; return sum; }, { activeMs: 0, idleMs: 0 });
  }
  function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4200); }
  async function run(fn, button) {
    if (button) button.disabled = true;
    try { return await fn(); } catch (error) { toast(error?.message || 'Something went wrong. Please try again.'); }
    finally { if (button?.isConnected) button.disabled = false; }
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(String(text)); }
    catch {
      const area = node('textarea'); area.value = String(text); area.style.position = 'fixed'; area.style.opacity = '0'; document.body.append(area); area.select();
      const copied = document.execCommand('copy'); area.remove(); if (!copied) throw new Error('Clipboard unavailable. Try reopening the dashboard.');
    }
    toast('Copied to clipboard.');
  }
  function makeSummary(chat) {
    const day = todayTotals(chat);
    return `${chat.title || 'Untitled conversation'}\nToday: ${duration(day.activeMs)} active · ${duration(day.idleMs)} idle\nAll time: ${duration(chat.totals?.activeMs)} active · ${duration(chat.totals?.idleMs)} idle\n${safeUrl(chat.url) || 'Claude conversation'}\nActivity estimates from Claude Compass.`;
  }
  async function request(type, payload = {}) {
    let response;
    if (DEMO) response = demoRequest(type, payload);
    else {
      if (!globalThis.chrome?.runtime?.sendMessage) throw new Error('Open this dashboard from the installed Claude Compass extension. For a sample preview, add ?demo=1 to the address.');
      response = await chrome.runtime.sendMessage({ type, ...payload });
    }
    if (!response?.ok) throw new Error(response?.error || 'The extension could not complete this request. Try reopening it.');
    if (response.state) { state = response.state; render(); }
    return response;
  }
  function makeDemo() {
    const sample = C.defaultState();
    const demoTheme = new URLSearchParams(location.search).get('theme');
    sample.settings.theme = ['system', 'light', 'dark'].includes(demoTheme) ? demoTheme : 'system';
    const now = Date.now(); const day = C.dayKey(new Date());
    const chats = [
      ['demo-strategy', 'Product strategy · the next chapter', '#8175A6', 5040000, 1080000, 16320000, 3240000],
      ['demo-writing', 'A better onboarding experience', '#68948B', 2820000, 480000, 10740000, 1560000],
      ['demo-research', 'Research notes & interesting rabbit holes', '#BD9872', 1740000, 780000, 8040000, 2280000],
      ['demo-build', 'Building the little things', '#8A9AB4', 1320000, 360000, 5940000, 1020000]
    ];
    chats.forEach(([id, title, color, active, idle, totalActive, totalIdle], index) => {
      sample.chats[id] = { id, title, color, url: 'https://claude.ai/new', createdAt: now - 604800000, updatedAt: now - index * 780000, totals: { activeMs: totalActive, idleMs: totalIdle }, days: { [day]: { activeMs: active, idleMs: idle } } };
    });
    sample.agents = {
      'demo-agent-1': { id: 'demo-agent-1', chatId: 'demo-strategy', name: 'Market landscape researcher', status: 'running', result: 'Reviewing onboarding patterns across six products. Comparing the first-session experience, time to value, and upgrade prompts.', source: 'observed', updatedAt: now - 120000, read: false },
      'demo-agent-2': { id: 'demo-agent-2', chatId: 'demo-writing', name: 'Onboarding copy review', status: 'completed', result: 'Reviewed the five welcome screens. Recommended shorter action labels, a single primary next step, and a sample project before asking users to start from scratch.\n\nReady for a final editorial pass.', source: 'observed', updatedAt: now - 1200000, read: false },
      'demo-agent-3': { id: 'demo-agent-3', chatId: 'demo-build', name: 'Accessibility check', status: 'completed', result: 'Keyboard navigation and focus order checked. Two low-contrast secondary labels need attention before shipping.', source: 'manual', updatedAt: now - 3500000, read: true }
    };
    sample.reports = [
      { id: 'demo-report-1', chatId: 'demo-strategy', createdAt: now - 1800000, activeMs: 5040000, idleMs: 1080000, text: 'Product strategy · the next chapter\n1h 24m active · 18m idle today.\nActivity snapshot from Claude Compass.' },
      { id: 'demo-report-2', chatId: 'demo-writing', createdAt: now - 3900000, activeMs: 2820000, idleMs: 480000, text: 'A better onboarding experience\n47m active · 8m idle today.\nActivity snapshot from Claude Compass.' }
    ];
    return sample;
  }
  function demoRequest(type, payload) {
    let report;
    switch (type) {
      case 'SET_COLOR': if (state.chats[payload.chatId]) state.chats[payload.chatId].color = payload.color; break;
      case 'UPDATE_SETTINGS': state.settings = { ...state.settings, ...payload.settings }; break;
      case 'SAVE_AGENT': {
        const id = payload.agent.id || `preview-${Date.now()}`;
        state.agents[id] = { ...state.agents[id], ...payload.agent, id, source: 'manual', read: false, updatedAt: Date.now() }; break;
      }
      case 'MARK_READ': if (state.agents[payload.agentId]) state.agents[payload.agentId].read = true; break;
      case 'CREATE_REPORT': {
        const chat = state.chats[payload.chatId]; if (!chat) throw new Error('Conversation unavailable.');
        report = { id: `preview-report-${Date.now()}`, chatId: chat.id, createdAt: Date.now(), ...todayTotals(chat), text: makeSummary(chat) }; state.reports.unshift(report); break;
      }
      case 'DELETE_CHAT': delete state.chats[payload.chatId]; state.reports = state.reports.filter((r) => r.chatId !== payload.chatId); for (const [id, agent] of Object.entries(state.agents)) if (agent.chatId === payload.chatId) delete state.agents[id]; break;
      case 'RESET_DATA': state = C.defaultState(); break;
      case 'GET_STATE': break;
      default: throw new Error('That action is unavailable in preview mode.');
    }
    return { ok: true, state, report };
  }
  function showPage(next) {
    page = next;
    for (const name of ['overview', 'mailbox', 'settings']) $(`page-${name}`).hidden = name !== next;
    document.querySelectorAll('[data-page]').forEach((button) => { const active = button.dataset.page === next; button.classList.toggle('active', active); if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
    document.title = `${next === 'mailbox' ? 'Agent mailbox' : next === 'settings' ? 'Settings' : 'Overview'} · Claude Compass`;
    if (next === 'mailbox') renderAgents();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  function render() {
    globalThis.CompassAppearance.apply(themePreview || state.settings.theme || 'system', !themePreview);
    const totals = totalsForToday();
    const agents = Object.values(state.agents || {});
    const unread = agents.filter((agent) => !agent.read).length;
    $('active-today').textContent = duration(totals.activeMs);
    $('idle-today').textContent = duration(totals.idleMs);
    $('chat-count').textContent = Object.keys(state.chats).length;
    $('chat-count-chip').textContent = Object.keys(state.chats).length;
    const running = agents.filter((agent) => agent.status === 'running').length;
    $('running-count').textContent = running;
    $('running-noun').textContent = running === 1 ? 'agent' : 'agents';
    $('nav-unread').textContent = unread; $('nav-unread').hidden = unread === 0;
    $('pause-label').textContent = state.settings.paused ? 'Tracking paused' : 'Tracking on';
    $('pause-button').classList.toggle('is-paused', !!state.settings.paused);
    $('pause-button').title = state.settings.paused ? 'Resume activity tracking' : 'Pause activity tracking';
    if (!settingsDirty && !$('settings-form').contains(document.activeElement)) {
      $('theme-setting').value = state.settings.theme || 'system';
      $('idle-seconds').value = state.settings.idleSeconds;
      $('update-minutes').value = state.settings.updateMinutes;
      $('paused-setting').checked = state.settings.paused;
    }
    if (!$('chat-list').contains(document.activeElement)) renderChats();
    renderReports();
    if (document.activeElement !== $('mailbox-chat')) updateChatSelect($('mailbox-chat'), true, false);
    renderAgents();
  }
  function renderChats() {
    const query = $('chat-search').value.toLowerCase().trim();
    const chats = Object.values(state.chats).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const filtered = chats.filter((chat) => String(chat.title || '').toLowerCase().includes(query));
    $('chat-list').replaceChildren(...filtered.map(chatCard));
    $('empty-chats').hidden = chats.length > 0;
    if (chats.length && !filtered.length) $('chat-list').append(node('div', 'inline-empty', 'No conversations match your search.'));
  }
  function chatCard(chat) {
    const card = node('article', 'chat-card'); card.dataset.chatId = chat.id; card.style.setProperty('--chat-color', safeColor(chat.color, chat.id));
    const content = node('div', 'chat-content'); const top = node('div', 'chat-top');
    const swatch = node('label', 'chat-swatch'); const swatchIcon = node('span', '', '✳'); swatchIcon.setAttribute('aria-hidden', 'true'); swatch.append(swatchIcon); swatch.title = `Change color for ${chat.title}`;
    const color = node('input'); color.type = 'color'; color.value = safeColor(chat.color, chat.id); color.setAttribute('aria-label', `Color for ${chat.title}`);
    color.addEventListener('change', () => run(async () => { await request('SET_COLOR', { chatId: chat.id, color: color.value }); card.style.setProperty('--chat-color', color.value); toast('Conversation color updated.'); })); swatch.append(color);
    const titleBlock = node('div', 'chat-title-block'); const url = safeUrl(chat.url);
    const title = node(url ? 'a' : 'span', 'chat-title', chat.title || 'Untitled conversation'); if (url) { title.href = url; title.target = '_blank'; title.rel = 'noopener noreferrer'; }
    title.title = chat.title || 'Untitled conversation';
    const subtitle = node('div', 'chat-subtitle'); subtitle.append(node('span', '', `Last visited ${dateText(chat.updatedAt)}`), node('span', '', '·'), node('span', 'color-hint', 'Click color to edit'));
    titleBlock.append(title, subtitle);
    const actions = node('div', 'chat-actions');
    actions.append(action('Save update', 'button small', async () => { await request('CREATE_REPORT', { chatId: chat.id }); toast('Activity update saved.'); }), action('Copy', 'button subtle', () => copy(makeSummary(chat)), 'Copy this conversation’s activity summary'), action('Mailbox', 'button subtle small', () => { $('mailbox-chat').value = chat.id; showPage('mailbox'); }, 'View this conversation’s agent mailbox'), action('×', 'icon-button', async () => { if (confirm(`Remove “${chat.title}” and its Compass data from this device? This does not delete your Claude conversation.`)) { await request('DELETE_CHAT', { chatId: chat.id }); toast('Conversation data removed.'); } }, 'Remove saved conversation data'));
    top.append(swatch, titleBlock, actions);
    const stats = node('div', 'chat-stats'); const day = todayTotals(chat);
    for (const [label, value, idle] of [['Active today', day.activeMs, false], ['Idle today', day.idleMs, true]]) { const stat = node('div', 'chat-stat'); stat.append(node('span', `mini-dot${idle ? ' idle' : ''}`), node('span', '', label), node('strong', '', duration(value))); stats.append(stat); }
    const all = node('div', 'chat-stat all-time'); all.append(node('span', '', 'All time'), node('strong', '', `${duration(chat.totals?.activeMs)} active / ${duration(chat.totals?.idleMs)} idle`)); stats.append(all);
    const bar = node('div', 'time-bar'); const active = node('span'); const total = (Number(day.activeMs) || 0) + (Number(day.idleMs) || 0); active.style.width = `${total ? Math.round((Number(day.activeMs) || 0) / total * 100) : 0}%`; bar.title = `${duration(day.activeMs)} active, ${duration(day.idleMs)} idle today`; bar.append(active); stats.append(bar);
    content.append(top, stats); card.append(node('div', 'chat-accent'), content); return card;
  }
  function renderReports() {
    const reports = [...(state.reports || [])].sort((a, b) => b.createdAt - a.createdAt);
    $('empty-reports').hidden = reports.length > 0;
    $('reports-list').replaceChildren(...reports.map((report) => {
      const card = node('article', 'report-card'); card.style.setProperty('--chat-color', safeColor(state.chats[report.chatId]?.color, report.chatId));
      const top = node('div', 'report-top'); top.append(node('span', 'report-dot'), node('span', 'report-title', chatName(report.chatId)), node('span', 'report-date', dateText(report.createdAt)));
      const content = node('p', 'report-text', report.text); content.title = report.text;
      card.append(top, content, action('Copy update ↗', 'button', () => copy(report.text))); return card;
    }));
  }
  function updateChatSelect(select, all, manual) {
    const previous = select.value; const options = [];
    if (all) { const option = node('option', '', 'All conversations'); option.value = ''; options.push(option); }
    if (manual) { const option = node('option', '', 'Unassigned session'); option.value = 'manual-session'; options.push(option); }
    const sessions = new Map(Object.values(state.chats).map((chat) => [chat.id, chat.title || 'Untitled conversation']));
    for (const agent of Object.values(state.agents || {})) if (!sessions.has(agent.chatId) && agent.chatId && agent.chatId !== 'manual-session') sessions.set(agent.chatId, 'Conversation unavailable');
    if (all && Object.values(state.agents || {}).some((agent) => agent.chatId === 'manual-session')) sessions.set('manual-session', 'Unassigned session');
    for (const [id, title] of sessions) { const option = node('option', '', title); option.value = id; options.push(option); }
    select.replaceChildren(...options); if (options.some((option) => option.value === previous)) select.value = previous;
  }
  function renderAgents(force = false) {
    if (!force && $('agents-list').contains(document.activeElement)) return;
    const filterChat = $('mailbox-chat').value; const filterStatus = $('mailbox-status').value;
    const agents = Object.values(state.agents || {}).filter((agent) => (!filterChat || agent.chatId === filterChat) && (filterStatus === 'all' || filterStatus === 'read' && agent.read || filterStatus === 'unread' && !agent.read || agent.status === filterStatus)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const fingerprint = JSON.stringify([filterChat, filterStatus, agents.map((agent) => [agent, chatName(agent.chatId), state.chats[agent.chatId]?.color])]);
    if (fingerprint === agentFingerprint) return;
    agentFingerprint = fingerprint;
    $('mailbox-count').textContent = `${agents.length} ${agents.length === 1 ? 'entry' : 'entries'}`;
    $('empty-agents').hidden = agents.length > 0;
    $('agents-list').replaceChildren(...agents.map((agent) => {
      const card = node('article', `agent-card${agent.read ? '' : ' unread'}`); const top = node('div', 'agent-top');
      const title = node('div', 'agent-title-block'); title.append(node('h3', '', agent.name || 'Unnamed agent'));
      const meta = node('div', 'agent-meta'); const dot = node('span', 'report-dot'); dot.style.setProperty('--chat-color', safeColor(state.chats[agent.chatId]?.color, agent.chatId));
      meta.append(dot, node('span', '', chatName(agent.chatId)), node('span', 'source-tag', agent.source === 'observed' ? 'Observed on page' : 'Manual entry')); title.append(meta);
      const status = ['running', 'completed', 'failed', 'unknown'].includes(agent.status) ? agent.status : 'unknown';
      top.append(node('div', 'agent-avatar', '✳'), title, node('span', `agent-badge ${status}`, status));
      const result = node('div', `agent-result${agent.result ? '' : ' empty'}`, agent.result || 'No result recorded yet.');
      const footer = node('div', 'agent-footer'); footer.append(node('span', 'muted', `${agent.source === 'observed' ? 'Last observed' : 'Last updated'} ${dateText(agent.updatedAt)}${agent.read ? ' · Read' : ' · Unread'}`));
      if (agent.result) footer.append(action('Copy result', 'button subtle', () => copy(agent.result)));
      if (agent.source !== 'observed') footer.append(action('Edit', 'button subtle', () => openAgent(agent)));
      if (!agent.read) footer.append(action('Mark as read', 'button', async () => { await request('MARK_READ', { agentId: agent.id }); renderAgents(true); toast('Agent entry marked as read.'); }));
      card.append(top, result, footer); return card;
    }));
  }
  function openAgent(agent) {
    if (!Object.keys(state.chats).length) { toast('Open a conversation on claude.ai first, then add an agent to that session.'); return; }
    $('agent-dialog-title').textContent = agent ? 'Update an agent' : 'Add an agent'; $('agent-id').value = agent?.id || ''; $('agent-name').value = agent?.name || ''; $('agent-result').value = agent?.result || ''; $('agent-status').value = agent?.status || 'running';
    updateChatSelect($('agent-chat'), false, false);
    $('agent-chat').disabled = !!agent;
    $('agent-chat').title = agent ? 'An existing agent stays in its original conversation.' : '';
    document.querySelector('.dialog-help').textContent = agent ? 'This is a manual record. Its conversation stays fixed; update its status and result as the work changes.' : 'This is a manual record. Update it when the agent’s work changes.';
    $('agent-chat').value = agent?.chatId || (state.chats[$('mailbox-chat').value] ? $('mailbox-chat').value : '') || Object.keys(state.chats)[0];
    $('agent-dialog').showModal(); $('agent-name').focus();
  }
  document.querySelectorAll('[data-page]').forEach((button) => button.addEventListener('click', () => showPage(button.dataset.page)));
  $('chat-search').addEventListener('input', renderChats);
  $('chat-list').addEventListener('focusout', () => setTimeout(() => { if (!$('chat-list').contains(document.activeElement)) renderChats(); }, 0));
  $('mailbox-chat').addEventListener('change', () => renderAgents(true)); $('mailbox-status').addEventListener('change', () => renderAgents(true));
  $('agents-list').addEventListener('focusout', () => setTimeout(() => { if (!$('agents-list').contains(document.activeElement)) renderAgents(); }, 0));
  $('pause-button').addEventListener('click', () => run(async () => { await request('UPDATE_SETTINGS', { settings: { paused: !state.settings.paused } }); toast(state.settings.paused ? 'Activity tracking paused.' : 'Activity tracking resumed.'); }, $('pause-button')));
  $('copy-day').addEventListener('click', () => run(async () => { const total = totalsForToday(); const lines = Object.values(state.chats).filter((chat) => { const d = todayTotals(chat); return d.activeMs || d.idleMs; }).map((chat) => { const d = todayTotals(chat); return `• ${chat.title}: ${duration(d.activeMs)} active, ${duration(d.idleMs)} idle`; }); await copy(`Claude Compass · ${new Date().toLocaleDateString()}\n${duration(total.activeMs)} active · ${duration(total.idleMs)} idle\n\n${lines.join('\n') || 'No activity recorded today.'}\n\nActivity estimates, stored locally.`); }, $('copy-day')));
  $('add-agent').addEventListener('click', () => openAgent()); $('empty-add-agent').addEventListener('click', () => openAgent());
  $('close-agent').addEventListener('click', () => $('agent-dialog').close()); $('cancel-agent').addEventListener('click', () => $('agent-dialog').close());
  $('agent-form').addEventListener('submit', (event) => { event.preventDefault(); run(async () => { const name = $('agent-name').value.trim(); if (!name) throw new Error('Add an agent name.'); await request('SAVE_AGENT', { agent: { ...($('agent-id').value ? { id: $('agent-id').value } : {}), chatId: $('agent-chat').value, name, status: $('agent-status').value, result: $('agent-result').value.trim() } }); $('agent-dialog').close(); toast('Agent entry saved.'); }, $('agent-form').querySelector('[type="submit"]')); });
  $('settings-form').addEventListener('input', () => { settingsDirty = true; });
  $('theme-setting').addEventListener('change', () => { themePreview = $('theme-setting').value; globalThis.CompassAppearance.apply(themePreview); });
  $('settings-form').addEventListener('submit', (event) => { event.preventDefault(); run(async () => { const settings = { theme: $('theme-setting').value, idleSeconds: Number($('idle-seconds').value), updateMinutes: Number($('update-minutes').value), paused: $('paused-setting').checked }; await request('UPDATE_SETTINGS', { settings }); settingsDirty = false; themePreview = null; globalThis.CompassAppearance.apply(state.settings.theme || 'system', true); toast('Preferences saved.'); }, $('settings-form').querySelector('[type="submit"]')); });
  $('export-data').addEventListener('click', () => run(() => { const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = node('a'); link.href = url; link.download = `claude-compass${DEMO ? '-sample' : ''}-${C.dayKey(new Date())}.json`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('Local data exported.'); }));
  $('reset-data').addEventListener('click', () => run(async () => { if (!confirm('Delete all Compass colors, time totals, agent entries, saved updates, and preferences from this device? This cannot be undone. Your Claude conversations will remain.')) return; await request('RESET_DATA'); settingsDirty = false; themePreview = null; render(); toast('All Compass data reset.'); }));
  $('today-label').textContent = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  $('demo-banner').hidden = !DEMO;
  if (DEMO) { state = makeDemo(); $('brand-link')?.setAttribute('href', 'dashboard.html?demo=1'); document.querySelector('.brand').href = 'dashboard.html?demo=1'; }
  if (!DEMO && globalThis.chrome?.storage?.onChanged) chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.compassState?.newValue) { state = changes.compassState.newValue; render(); } });
  (async () => {
    try {
      await request('GET_STATE');
      if (new URLSearchParams(location.search).get('view') === 'mailbox') showPage('mailbox');
      if (selectedChat && [...$('mailbox-chat').options].some((option) => option.value === selectedChat)) { $('mailbox-chat').value = selectedChat; showPage('mailbox'); }
    } catch (error) { $('connection-error').textContent = error.message || 'Unable to load Compass. Please reopen the extension.'; $('connection-error').hidden = false; }
  })();
});
