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

document.addEventListener('DOMContentLoaded', () => {
  'use strict';
  const $ = (id) => document.getElementById(id); const C = globalThis.Compass; let state;
  const node = (tag, cls, text) => { const item = document.createElement(tag); if (cls) item.className = cls; if (text !== undefined) item.textContent = String(text); return item; };
  async function request(type, payload = {}) { const response = await chrome.runtime.sendMessage({ type, ...payload }); if (!response?.ok) throw new Error(response?.error || 'Unable to connect to Compass.'); if (response.state) { state = response.state; render(); } return response; }
  function safeUrl(value) { try { const url = new URL(value); return url.protocol === 'https:' && ['claude.ai', 'www.claude.ai'].includes(url.hostname) ? url.href : null; } catch { return null; } }
  function render() {
    globalThis.CompassAppearance.apply(state.settings.theme || 'system', true);
    const chats = Object.values(state.chats || {}); const dayKey = C.dayKey(new Date()); const totals = chats.reduce((sum, chat) => { sum.active += Number(chat.days?.[dayKey]?.activeMs) || 0; sum.idle += Number(chat.days?.[dayKey]?.idleMs) || 0; return sum; }, { active: 0, idle: 0 });
    $('active').textContent = C.formatDuration(totals.active); $('idle').textContent = C.formatDuration(totals.idle); $('count').textContent = chats.length;
    const unread = Object.values(state.agents || {}).filter((agent) => !agent.read).length; $('unread').textContent = `${unread} unread`;
    $('tracking-label').textContent = state.settings.paused ? 'Paused' : 'Tracking'; $('pause').classList.toggle('paused', !!state.settings.paused); $('pause').title = state.settings.paused ? 'Resume tracking' : 'Pause tracking';
    $('empty').hidden = chats.length > 0;
    $('chats').replaceChildren(...chats.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4).map((chat) => {
      const url = safeUrl(chat.url); const row = node(url ? 'a' : 'div', 'chat'); if (url) { row.href = url; row.target = '_blank'; row.rel = 'noopener noreferrer'; }
      const swatch = node('span', 'swatch', '✳'); swatch.setAttribute('aria-hidden', 'true'); swatch.style.backgroundColor = /^#[\da-f]{6}$/i.test(chat.color || '') ? chat.color : C.colorForId(chat.id);
      const info = node('div', 'chat-info'); const today = chat.days?.[dayKey] || {}; info.append(node('div', 'chat-title', chat.title || 'Untitled conversation'), node('div', 'chat-time', `${C.formatDuration(today.activeMs || 0)} active · ${C.formatDuration(today.idleMs || 0)} idle today`));
      row.append(swatch, info, node('span', 'chat-arrow', '↗')); return row;
    }));
  }
  async function run(fn) { try { await fn(); $('error').hidden = true; } catch (error) { $('error').textContent = error.message || 'Unable to load Compass.'; $('error').hidden = false; } }
  $('pause').addEventListener('click', () => run(() => request('UPDATE_SETTINGS', { settings: { paused: !state?.settings?.paused } })));
  $('dashboard').addEventListener('click', () => run(async () => { await request('OPEN_DASHBOARD'); window.close(); }));
  $('mailbox').addEventListener('click', () => run(async () => { await chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html?view=mailbox') }); window.close(); }));
  if (globalThis.chrome?.storage?.onChanged) chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.compassState?.newValue) { state = changes.compassState.newValue; render(); } });
  run(() => request('GET_STATE'));
});
