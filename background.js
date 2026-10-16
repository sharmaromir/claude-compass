'use strict';
importScripts('common.js');

const STATE_KEY = 'compassState';
const SESSION_KEY = 'compassObservation';
const MAX_CHATS = 500;
const MAX_AGENTS = 1000;
const MAX_REPORTS = 500;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const TERMINAL = new Set(['completed', 'failed']);
const STATUSES = new Set(['running', 'completed', 'failed', 'unknown']);
let state;
let observation = null;
let queue = Promise.resolve();
const snapshotEpoch = crypto.randomUUID();
let snapshotSequence = 0;

function text(value, limit, fallback = '') {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, limit) : fallback;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assert(condition, message) { if (!condition) throw new Error(message); }

async function initialize() {
  if (state) return;
  const saved = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY];
  state = saved && saved.version === 1 && isPlainObject(saved.chats) && isPlainObject(saved.agents) && Array.isArray(saved.reports) ? saved : Compass.defaultState();
  state.settings = { ...Compass.defaultState().settings, ...state.settings };
  if (!['system', 'light', 'dark'].includes(state.settings.theme)) state.settings.theme = 'system';
  try {
    const pending = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY];
    if (pending && Date.now() - pending.at >= 0 && Date.now() - pending.at <= Compass.MAX_HEARTBEAT_GAP_MS) {
      const [tab, window] = await Promise.all([chrome.tabs.get(pending.tabId), chrome.windows.get(pending.windowId)]);
      // Tab identity and focus are available without the broad tabs permission.
      // The next heartbeat supplies the current route; no hidden URL access is needed.
      if (tab.active && tab.windowId === pending.windowId && window.focused) observation = pending;
    }
  } catch (_) { observation = null; }
}

function serialized(task) {
  const run = queue.then(async () => { await initialize(); return task(); });
  queue = run.catch(() => {});
  return run;
}

async function save(changed, timingChanged = false) {
  try {
    if (changed) {
      assert(new TextEncoder().encode(JSON.stringify(state)).byteLength <= MAX_STATE_BYTES, 'Compass local storage is nearly full. Export your data and delete an older chat before adding more.');
      await chrome.storage.local.set({ [STATE_KEY]: state });
    }
    if (timingChanged) {
      if (observation) await chrome.storage.session.set({ [SESSION_KEY]: observation });
      else await chrome.storage.session.remove(SESSION_KEY);
    }
  } catch (error) {
    // Never leave rejected writes visible in the cache or credit the same interval
    // again after a failed persistence operation. Reload the committed record.
    observation = null;
    state = undefined;
    try { await chrome.storage.session.remove(SESSION_KEY); } catch (_) {}
    try {
      const committed = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY];
      state = committed || Compass.defaultState();
      state.settings = { ...Compass.defaultState().settings, ...state.settings };
    } catch (_) {}
    throw error;
  }
}

function validateSender(sender) {
  assert(sender.id === chrome.runtime.id, 'Unrecognized extension sender.');
  const url = new URL(sender.url || sender.origin || 'about:blank');
  const internal = url.protocol === 'chrome-extension:' && url.hostname === chrome.runtime.id;
  const claude = url.protocol === 'https:' && url.hostname === 'claude.ai' && !url.port;
  assert(internal || claude, 'This message must come from Claude or the extension.');
  return { internal, claude };
}

function validateChat(input) {
  assert(isPlainObject(input), 'A chat is required.');
  const parsed = Compass.chatFromUrl(input.url);
  assert(parsed && parsed.id === input.id, 'Invalid Claude chat URL or ID.');
  return { ...parsed, title: text(input.title, 200, 'Untitled chat') || 'Untitled chat' };
}

function upsertChat(input, at) {
  const chat = validateChat(input);
  let existing = state.chats[chat.id];
  if (!existing) {
    assert(Object.keys(state.chats).length < MAX_CHATS, 'Chat limit reached. Delete older chats to add more.');
    existing = state.chats[chat.id] = Compass.createChat(chat, at);
    return true;
  }
  if (existing.title === chat.title && existing.url === chat.url) return false;
  existing.title = chat.title;
  existing.url = chat.url;
  existing.updatedAt = at;
  return true;
}

function requireChat(id) {
  assert(typeof id === 'string' && Object.hasOwn(state.chats, id), 'Chat not found.');
  return state.chats[id];
}

function makeReport(chatId, at, automatic = false) {
  const chat = requireChat(chatId);
  const prior = [...state.reports].reverse().find(report => report.chatId === chatId);
  const activeMs = Math.max(0, chat.totals.activeMs - (prior?.totalActiveMs || 0));
  const idleMs = Math.max(0, chat.totals.idleMs - (prior?.totalIdleMs || 0));
  const report = {
    id: crypto.randomUUID(), chatId, createdAt: at, activeMs, idleMs,
    totalActiveMs: chat.totals.activeMs, totalIdleMs: chat.totals.idleMs, automatic,
    text: `${chat.title}: ${Compass.formatDuration(activeMs)} active and ${Compass.formatDuration(idleMs)} idle since ${prior ? 'the previous update' : 'tracking began'}. Total: ${Compass.formatDuration(chat.totals.activeMs)} active, ${Compass.formatDuration(chat.totals.idleMs)} idle.`
  };
  state.reports.push(report);
  if (state.reports.length > MAX_REPORTS) state.reports.splice(0, state.reports.length - MAX_REPORTS);
  return report;
}

function flush(next, allowAutomaticReport = true) {
  if (!observation || !state.chats[observation.chatId]) return false;
  const chat = state.chats[observation.chatId];
  const segments = Compass.creditInterval(observation, next, state.settings);
  if (!Compass.applySegments(chat, segments)) return false;
  const previousReport = [...state.reports].reverse().find(report => report.chatId === chat.id);
  const baseline = (previousReport?.totalActiveMs || 0) + (previousReport?.totalIdleMs || 0);
  if (allowAutomaticReport && state.settings.updateMinutes > 0 && chat.totals.activeMs + chat.totals.idleMs - baseline >= state.settings.updateMinutes * 60000) makeReport(chat.id, next.at, true);
  return true;
}

function agentRecord(input, chatId, source, at) {
  assert(isPlainObject(input), 'Invalid agent.');
  requireChat(chatId);
  const name = text(input.name, 160);
  assert(name, 'An agent name is required.');
  assert(STATUSES.has(input.status), 'Invalid agent status.');
  const suppliedId = text(input.id, 240);
  // Observed IDs are namespaced by chat so equal tool IDs cannot overwrite another session.
  const id = source === 'observed' ? `observed:${chatId}:${suppliedId || name}` : suppliedId || `manual:${crypto.randomUUID()}`;
  assert(!['__proto__', 'constructor', 'prototype'].includes(id), 'Invalid agent ID.');
  const previous = Object.hasOwn(state.agents, id) ? state.agents[id] : null;
  if (previous) assert(previous.chatId === chatId && previous.source === source, 'This agent belongs to another chat or source.');
  else assert(Object.keys(state.agents).length < MAX_AGENTS, 'Mailbox limit reached. Delete older chat data to make room.');
  if (source === 'observed' && TERMINAL.has(previous?.status) && input.status !== previous.status) return false;
  const status = source === 'observed' && TERMINAL.has(previous?.status) ? previous.status : input.status;
  const result = text(input.result, 12000) || (source === 'observed' ? previous?.result || '' : '');
  if (previous && previous.name === name && previous.status === status && previous.result === result) return false;
  state.agents[id] = { id, chatId, name, status, result, source, updatedAt: at, read: false };
  return true;
}

async function handle(message, sender) {
  assert(isPlainObject(message) && typeof message.type === 'string', 'Invalid message.');
  const origin = validateSender(sender);
  const now = Date.now();
  let changed = false;
  let timingChanged = false;
  let result = {};
  switch (message.type) {
    case 'GET_STATE': break;
    case 'HEARTBEAT': {
      assert(origin.claude && Number.isInteger(sender.tab?.id), 'Heartbeat requires a Claude tab.');
      if (message.chat === null) {
        if (observation?.tabId === sender.tab.id) {
          changed = flush({ ...observation, chatId: null, at: now });
          observation = null;
          timingChanged = true;
        }
        break;
      }
      const chat = validateChat(message.chat);
      // sender.url can remain the document's original URL after Claude's SPA navigation.
      // Sender extension ID + exact Claude origin authenticate our isolated content script.
      if (sender.tab.url) assert(Compass.chatFromUrl(sender.tab.url)?.id === chat.id, 'Heartbeat chat does not match the current tab.');
      assert(Number.isFinite(message.lastActivityAt) && message.lastActivityAt >= 0 && message.lastActivityAt <= now + 1000, 'Invalid activity timestamp.');
      const browserWindow = await chrome.windows.get(sender.tab.windowId).catch(() => null);
      const browserForeground = sender.tab.active !== false && browserWindow?.focused === true;
      result.foregroundEligible = browserForeground && message.visible === true && message.focused === true;
      changed = upsertChat(chat, now);
      const next = {
        tabId: sender.tab.id, windowId: sender.tab.windowId, chatId: chat.id, at: now,
        lastActivityAt: Math.min(now, message.lastActivityAt), visible: message.visible === true, focused: message.focused === true && browserForeground
      };
      // An inactive page's periodic ping must not interrupt another foreground tab.
      if (next.visible && next.focused || observation?.tabId === next.tabId) {
        changed = flush(next) || changed;
        observation = state.settings.paused ? null : next;
        timingChanged = true;
      }
      break;
    }
    case 'UPSERT_CHAT': changed = upsertChat(message.chat, now); break;
    case 'SET_COLOR': {
      const chat = requireChat(message.chatId);
      assert(typeof message.color === 'string' && /^#[0-9a-f]{6}$/i.test(message.color), 'Choose a six-digit hex color.');
      if (chat.color !== message.color.toLowerCase()) {
        chat.color = message.color.toLowerCase(); chat.updatedAt = now; changed = true;
      }
      break;
    }
    case 'UPDATE_SETTINGS': {
      assert(isPlainObject(message.settings), 'Settings are required.');
      const settings = { ...state.settings };
      for (const [key, value] of Object.entries(message.settings)) {
        if (key === 'idleSeconds') { assert(Number.isInteger(value) && value >= 15 && value <= 900, 'Idle threshold must be between 15 and 900 seconds.'); settings[key] = value; }
        else if (key === 'updateMinutes') { assert(Number.isInteger(value) && value >= 0 && value <= 240, 'Update interval must be between 0 and 240 minutes; 0 disables automatic updates.'); settings[key] = value; }
        else if (key === 'paused') { assert(typeof value === 'boolean', 'Paused must be true or false.'); settings[key] = value; }
        else if (key === 'theme') { assert(['system', 'light', 'dark'].includes(value), 'Choose system, light, or dark appearance.'); settings[key] = value; }
        else throw new Error('Unknown setting.');
      }
      if (JSON.stringify(settings) !== JSON.stringify(state.settings)) {
        if (settings.paused !== state.settings.paused || settings.idleSeconds !== state.settings.idleSeconds) {
          if (observation) flush({ ...observation, at: now });
          observation = null; timingChanged = true;
        }
        state.settings = settings; changed = true;
      }
      break;
    }
    case 'AGENTS_OBSERVED': {
      assert(origin.claude, 'Observed agents must come from Claude.');
      if (sender.tab?.url) assert(Compass.chatFromUrl(sender.tab.url)?.id === message.chatId, 'Agent chat does not match the current tab.');
      requireChat(message.chatId);
      assert(Array.isArray(message.agents) && message.agents.length <= 100, 'At most 100 agent observations are allowed at once.');
      // Validate and apply the entire batch atomically, including the in-memory cache.
      const originalAgents = state.agents;
      state.agents = { ...originalAgents };
      try {
        for (const agent of message.agents) changed = agentRecord(agent, message.chatId, 'observed', now) || changed;
      } catch (error) { state.agents = originalAgents; throw error; }
      break;
    }
    case 'SAVE_AGENT': changed = agentRecord(message.agent, message.agent?.chatId, 'manual', now); break;
    case 'MARK_READ': {
      assert(typeof message.agentId === 'string' && Object.hasOwn(state.agents, message.agentId), 'Agent not found.');
      if (!state.agents[message.agentId].read) { state.agents[message.agentId].read = true; changed = true; }
      break;
    }
    case 'CREATE_REPORT': {
      if (observation?.chatId === message.chatId) { flush({ ...observation, at: now }, false); observation.at = now; timingChanged = true; }
      result.report = makeReport(message.chatId, now); changed = true; break;
    }
    case 'DELETE_CHAT': {
      requireChat(message.chatId);
      delete state.chats[message.chatId];
      for (const [id, agent] of Object.entries(state.agents)) if (agent.chatId === message.chatId) delete state.agents[id];
      state.reports = state.reports.filter(report => report.chatId !== message.chatId);
      if (observation?.chatId === message.chatId) { observation = null; timingChanged = true; }
      changed = true; break;
    }
    case 'RESET_DATA': state = Compass.defaultState(); observation = null; changed = true; timingChanged = true; break;
    case 'OPEN_DASHBOARD': {
      const fragment = message.chatId && Object.hasOwn(state.chats, message.chatId) ? `#${encodeURIComponent(message.chatId)}` : '';
      await chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html${fragment}`) }); break;
    }
    default: throw new Error('Unknown Compass request.');
  }
  await save(changed, timingChanged);
  const tracked = observation && state.chats[observation.chatId];
  const timing = tracked ? {
    ...observation, ownedBySender: observation.tabId === sender.tab?.id,
    chatCreatedAt: tracked.createdAt, totals: { ...tracked.totals }
  } : null;
  return { ok: true, state, timing, snapshot: { epoch: snapshotEpoch, sequence: ++snapshotSequence }, ...result };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  serialized(() => handle(message, sender)).then(respond, error => respond({ ok: false, error: error.message || 'Compass could not complete this request.' }));
  return true;
});

function stopObservation(matches) {
  serialized(async () => {
    if (!observation || !matches(observation)) return;
    const changed = flush({ ...observation, at: Date.now() });
    observation = null;
    await save(changed, true);
  }).catch(() => {});
}

chrome.tabs.onActivated.addListener(info => stopObservation(current => current.windowId === info.windowId && current.tabId !== info.tabId));
chrome.tabs.onRemoved.addListener(tabId => stopObservation(current => current.tabId === tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) stopObservation(current => current.tabId === tabId && Compass.chatFromUrl(info.url)?.id !== current.chatId);
});
chrome.windows.onFocusChanged.addListener(windowId => stopObservation(current => current.windowId !== windowId));
