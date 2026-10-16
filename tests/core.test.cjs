const test = require('node:test');
const assert = require('node:assert/strict');
const Compass = require('../common.js');
const settings = Compass.defaultState().settings;
const base = { tabId: 1, chatId: 'chat:abc', at: 100000, lastActivityAt: 100000, visible: true, focused: true };
function sum(segments, kind) { return segments.filter(s => s.kind === kind).reduce((n, s) => n + s.end - s.start, 0); }

test('recognizes canonical Claude chats and code sessions, rejecting lookalike origins and new chats', () => {
  assert.deepEqual(Compass.chatFromUrl('https://claude.ai/chat/abc-123?x=1#hello'), { id: 'chat:abc-123', url: 'https://claude.ai/chat/abc-123' });
  assert.equal(Compass.chatFromUrl('https://claude.ai/code/session-123').id, 'code:session-123');
  for (const value of ['https://claude.ai/new', 'https://claude.ai/chat/new', 'https://claude.ai/code/new', 'https://claude.ai.evil.test/chat/abc', 'http://claude.ai/chat/abc', 'https://claude.ai:444/chat/abc', 'https://claude.ai/chat/abc/extra', 'garbage']) assert.equal(Compass.chatFromUrl(value), null);
});

test('stable palette colors and isolated defaults', () => {
  const colors = new Set(Array.from({ length: 80 }, (_, i) => Compass.colorForId(`chat:${i}`)));
  assert.ok(colors.size >= 6);
  assert.equal(Compass.colorForId('chat:abc'), Compass.colorForId('chat:abc'));
  for (const color of colors) assert.ok(Compass.PALETTE.includes(color));
  const first = Compass.defaultState(); first.settings.paused = true;
  assert.equal(Compass.defaultState().settings.paused, false);
});

test('credits a short foreground heartbeat and no hidden, unfocused, paused, sleeping or backwards intervals', () => {
  assert.equal(sum(Compass.creditInterval(base, { ...base, at: 105000 }, settings), 'activeMs'), 5000);
  for (const [previous, next, config] of [
    [{ ...base, visible: false }, { ...base, at: 105000 }, settings],
    [{ ...base, focused: false }, { ...base, at: 105000 }, settings],
    [base, { ...base, at: 105000 }, { ...settings, paused: true }],
    [base, { ...base, at: 115001 }, settings],
    [base, { ...base, at: 99999 }, settings]
  ]) assert.deepEqual(Compass.creditInterval(previous, next, config), []);
});

test('splits exactly at the inactivity cutoff and preserves idle before activity resumes', () => {
  const previous = { ...base, lastActivityAt: 42000 };
  const split = Compass.creditInterval(previous, { ...previous, at: 105000 }, settings);
  assert.equal(sum(split, 'activeMs'), 2000);
  assert.equal(sum(split, 'idleMs'), 3000);
  const resumed = Compass.creditInterval({ ...base, lastActivityAt: 30000 }, { ...base, at: 105000, lastActivityAt: 104000 }, settings);
  assert.equal(sum(resumed, 'idleMs'), 4000);
  assert.equal(sum(resumed, 'activeMs'), 1000);
  // A focus/idle flush may arrive milliseconds after the activity event itself.
  const delayedActivity = Compass.creditInterval({ ...base, lastActivityAt: 30000 }, { ...base, at: 105000, lastActivityAt: 99990 }, settings);
  assert.equal(sum(delayedActivity, 'activeMs'), 5000);
  assert.equal(sum(delayedActivity, 'idleMs'), 0);
});

test('navigation credits the previous chat without borrowing activity from the next chat', () => {
  const previous = { ...base, lastActivityAt: 30000 };
  const next = { ...base, chatId: 'chat:other', at: 105000, lastActivityAt: 104000 };
  assert.equal(sum(Compass.creditInterval(previous, next, settings), 'idleMs'), 5000);
  assert.equal(sum(Compass.creditInterval(base, { ...base, at: 105000, focused: false }, settings), 'activeMs'), 5000);
});

test('aggregates local dates correctly across midnight', () => {
  const midnight = new Date(2026, 9, 17, 0, 0, 0).getTime();
  const chat = Compass.createChat({ id: 'chat:abc', title: 'Example', url: 'https://claude.ai/chat/abc' }, midnight - 1000);
  assert.equal(Compass.applySegments(chat, [
    { start: midnight - 2000, end: midnight + 3000, kind: 'activeMs' },
    { start: midnight + 3000, end: midnight + 4000, kind: 'idleMs' }
  ]), 6000);
  assert.deepEqual(chat.totals, { activeMs: 5000, idleMs: 1000 });
  assert.deepEqual(chat.days['2026-10-16'], { activeMs: 2000, idleMs: 0 });
  assert.deepEqual(chat.days['2026-10-17'], { activeMs: 3000, idleMs: 1000 });
  assert.match(Compass.summarizeChat(chat), /5s active, 1s idle/);
});

test('duration formatting stays compact and handles missing or negative data', () => {
  assert.equal(Compass.formatDuration(-5), '0s');
  assert.equal(Compass.formatDuration(65000), '1m 5s');
  assert.equal(Compass.formatDuration(3600000), '1h');
  assert.equal(Compass.formatDuration(3660000), '1h 1m');
});

// Exercise the actual service worker with controlled clocks and Chrome API boundaries.
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto').webcrypto;
const workerSource = fs.readFileSync(require.resolve('../background.js'), 'utf8');
function workerFixture(previousStores) {
  const stores = previousStores || { local: {}, session: {} };
  const hooks = {};
  let clock = 1800000000000;
  let writes = 0;
  let failLocalWrite = false;
  let windowFocused = true;
  const currentTabs = new Map();
  const makeEvent = name => ({ addListener(listener) { hooks[name] = listener; } });
  const storageArea = name => ({
    async get(key) { return structuredClone({ [key]: stores[name][key] }); },
    async set(values) {
      if (name === 'local' && failLocalWrite) { failLocalWrite = false; throw new Error('QUOTA_BYTES quota exceeded'); }
      writes++; Object.assign(stores[name], structuredClone(values));
    },
    async remove(key) { writes++; delete stores[name][key]; }
  });
  class WorkerDate extends Date { static now() { return clock; } }
  const chrome = {
    runtime: { id: 'compass-test', onMessage: makeEvent('message'), getURL(path) { return `chrome-extension://compass-test/${path}`; } },
    storage: { local: storageArea('local'), session: storageArea('session') },
    tabs: {
      onActivated: makeEvent('activated'), onRemoved: makeEvent('removed'), onUpdated: makeEvent('updated'),
      async get(id) { return currentTabs.get(id) || { id, active: true, url: 'https://claude.ai/chat/abc', windowId: 1 }; },
      async create() {}
    },
    windows: { onFocusChanged: makeEvent('focus'), async get() { return { focused: windowFocused }; } }
  };
  vm.runInNewContext(workerSource, { chrome, Compass, URL, TextEncoder, Date: WorkerDate, crypto, importScripts() {} });
  const sender = { id: 'compass-test', url: 'chrome-extension://compass-test/dashboard.html' };
  const request = (message, from = sender) => new Promise(resolve => hooks.message(message, from, response => resolve(structuredClone(response))));
  return {
    stores, hooks, currentTabs, request,
    get writes() { return writes; }, get now() { return clock; },
    advance(ms) { clock += ms; }, setClock(ms) { clock = ms; },
    failNextWrite() { failLocalWrite = true; },
    setWindowFocused(value) { windowFocused = value; },
    heartbeat(id = 'abc', options = {}) {
      const chat = { id: `chat:${id}`, title: id, url: `https://claude.ai/chat/${id}` };
      const tabId = options.tabId || 1;
      const from = { id: 'compass-test', url: chat.url, tab: { id: tabId, windowId: options.windowId || 1, active: options.active ?? true } };
      return request({ type: 'HEARTBEAT', chat, lastActivityAt: options.lastActivityAt ?? clock, visible: options.visible ?? true, focused: options.focused ?? true }, from);
    },
    observed(chatId, agents) { return request({ type: 'AGENTS_OBSERVED', chatId: `chat:${chatId}`, agents }, { id: 'compass-test', url: `https://claude.ai/chat/${chatId}`, tab: { id: 1, windowId: 1 } }); }
  };
}

test('worker reads do not write, and background tabs cannot interrupt the active timing owner', async () => {
  const worker = workerFixture();
  assert.equal((await worker.request({ type: 'GET_STATE' })).ok, true);
  assert.equal(worker.writes, 0);
  await worker.heartbeat();
  worker.advance(5000);
  await worker.heartbeat();
  worker.advance(1000);
  await worker.heartbeat('background', { tabId: 2, visible: false, focused: false });
  worker.advance(4000);
  const result = await worker.heartbeat();
  assert.equal(result.state.chats['chat:abc'].totals.activeMs, 10000);
  assert.equal(result.state.chats['chat:background'].totals.activeMs, 0);
  const writes = worker.writes;
  await worker.request({ type: 'GET_STATE' });
  assert.equal(worker.writes, writes);
});

test('worker assigns navigation intervals to the prior chat and skips long missing-heartbeat gaps', async () => {
  const worker = workerFixture();
  await worker.heartbeat();
  worker.advance(5000);
  let result = await worker.heartbeat('def');
  assert.equal(result.state.chats['chat:abc'].totals.activeMs, 5000);
  assert.equal(result.state.chats['chat:def'].totals.activeMs, 0);
  worker.advance(5000);
  result = await worker.heartbeat('def');
  assert.equal(result.state.chats['chat:def'].totals.activeMs, 5000);
  worker.advance(60000);
  result = await worker.heartbeat('def');
  assert.equal(result.state.chats['chat:def'].totals.activeMs, 5000);
});

test('worker focus events flush elapsed foreground time, then stop counting', async () => {
  const worker = workerFixture();
  await worker.heartbeat();
  worker.advance(2000);
  worker.hooks.focus(-1);
  await worker.request({ type: 'GET_STATE' });
  worker.advance(9000);
  const result = await worker.heartbeat('abc', { visible: true, focused: false });
  assert.equal(result.state.chats['chat:abc'].totals.activeMs, 2000);
});

test('a recent session checkpoint survives service worker suspension without phantom sleep time', async () => {
  const first = workerFixture();
  await first.heartbeat();
  first.advance(5000);
  await first.heartbeat();
  const restarted = workerFixture(first.stores);
  restarted.currentTabs.set(1, { id: 1, active: true, windowId: 1 }); // No tabs or host permission exposes the URL.
  restarted.setClock(first.now + 5000);
  let result = await restarted.heartbeat();
  assert.equal(result.state.chats['chat:abc'].totals.activeMs, 10000);
  const staleRestart = workerFixture(restarted.stores);
  staleRestart.setClock(restarted.now + 60000);
  result = await staleRestart.heartbeat();
  assert.equal(result.state.chats['chat:abc'].totals.activeMs, 10000);
});

test('navigation to an unsaved chat flushes the previous session once and then clears it', async () => {
  const worker = workerFixture();
  await worker.heartbeat();
  worker.advance(3000);
  const sender = { id: 'compass-test', url: 'https://claude.ai/new', tab: { id: 1, windowId: 1 } };
  let result = await worker.request({ type: 'HEARTBEAT', chat: null }, sender);
  assert.equal(result.state.chats['chat:abc'].totals.activeMs, 3000);
  worker.advance(5000);
  result = await worker.request({ type: 'HEARTBEAT', chat: null }, sender);
  assert.equal(result.state.chats['chat:abc'].totals.activeMs, 3000);
  assert.equal(worker.stores.session.compassObservation, undefined);
});

test('automatic reports can be disabled without disabling time tracking', async () => {
  const worker = workerFixture();
  assert.equal((await worker.request({ type: 'UPDATE_SETTINGS', settings: { updateMinutes: 0 } })).ok, true);
  await worker.heartbeat();
  worker.advance(5000);
  const result = await worker.heartbeat();
  assert.equal(result.state.chats['chat:abc'].totals.activeMs, 5000);
  assert.equal(result.state.reports.length, 0);
});

test('observations preserve completion and read state, and reject invalid batches atomically', async () => {
  const worker = workerFixture();
  await worker.heartbeat();
  const agent = { id: 'tool-1', name: 'Research', status: 'completed', result: 'Finished checking the docs.' };
  const response = await worker.observed('abc', [agent]);
  const id = Object.keys(response.state.agents)[0];
  await worker.request({ type: 'MARK_READ', agentId: id });
  let result = await worker.observed('abc', [{ ...agent, status: 'running', result: 'Stale in-progress output' }]);
  assert.equal(result.state.agents[id].status, 'completed');
  assert.equal(result.state.agents[id].result, agent.result);
  assert.equal(result.state.agents[id].read, true);
  result = await worker.observed('abc', [{ id: 'tool-2', name: 'Second', status: 'running' }, { id: 'bad', name: 'Invalid', status: 'impossible' }]);
  assert.equal(result.ok, false);
  assert.equal(Object.keys((await worker.request({ type: 'GET_STATE' })).state.agents).length, 1);
});

test('automatic reports use tracked time and destructive changes preserve settings boundaries', async () => {
  const worker = workerFixture();
  await worker.request({ type: 'UPDATE_SETTINGS', settings: { updateMinutes: 1 } });
  await worker.heartbeat();
  let result;
  for (let i = 0; i < 12; i++) { worker.advance(5000); result = await worker.heartbeat(); }
  assert.equal(result.state.reports.length, 1);
  assert.equal(result.state.reports[0].activeMs, 60000);
  assert.equal(result.state.reports[0].automatic, true);
  await worker.request({ type: 'UPDATE_SETTINGS', settings: { paused: true } });
  worker.advance(5000);
  result = await worker.heartbeat();
  assert.equal(result.state.chats['chat:abc'].totals.activeMs, 60000);
  result = await worker.request({ type: 'DELETE_CHAT', chatId: 'chat:abc' });
  assert.equal(Object.keys(result.state.chats).length, 0);
  assert.equal(result.state.reports.length, 0);
  assert.equal(result.state.settings.paused, true);
});

test('worker rejects untrusted origins, invalid settings and mismatched chat identities', async () => {
  const worker = workerFixture();
  assert.equal((await worker.request({ type: 'GET_STATE' }, { id: 'compass-test', url: 'https://example.com/' })).ok, false);
  assert.equal((await worker.request({ type: 'UPDATE_SETTINGS', settings: { idleSeconds: 0 } })).ok, false);
  assert.equal((await worker.request({ type: 'UPSERT_CHAT', chat: { id: 'chat:different', title: 'No', url: 'https://claude.ai/chat/abc' } })).ok, false);
  assert.equal(Object.keys((await worker.request({ type: 'GET_STATE' })).state.chats).length, 0);
});

test('a manual report at the automatic threshold creates one useful update', async () => {
  const worker = workerFixture();
  await worker.request({ type: 'UPDATE_SETTINGS', settings: { updateMinutes: 1 } });
  await worker.heartbeat();
  for (let i = 0; i < 11; i++) { worker.advance(5000); await worker.heartbeat(); }
  worker.advance(5000);
  const result = await worker.request({ type: 'CREATE_REPORT', chatId: 'chat:abc' });
  assert.equal(result.state.reports.length, 1);
  assert.equal(result.report.activeMs, 60000);
  assert.equal(result.report.automatic, false);
});

test('SPA navigation uses the canonical content-script chat even when sender.url is stale', async () => {
  const worker = workerFixture();
  await worker.heartbeat();
  worker.advance(5000);
  const sender = { id: 'compass-test', url: 'https://claude.ai/chat/abc', tab: { id: 1, windowId: 1, url: 'https://claude.ai/chat/def' } };
  let result = await worker.request({
    type: 'HEARTBEAT', chat: { id: 'chat:def', title: 'Second chat', url: 'https://claude.ai/chat/def' },
    lastActivityAt: worker.now, visible: true, focused: true
  }, sender);
  assert.equal(result.ok, true);
  assert.equal(result.state.chats['chat:abc'].totals.activeMs, 5000);
  result = await worker.request({ type: 'AGENTS_OBSERVED', chatId: 'chat:def', agents: [{ id: 'tool', name: 'Research', status: 'running' }] }, sender);
  assert.equal(result.ok, true);
  assert.equal(Object.values(result.state.agents)[0].chatId, 'chat:def');
  const mismatch = await worker.request({ type: 'AGENTS_OBSERVED', chatId: 'chat:abc', agents: [] }, sender);
  assert.equal(mismatch.ok, false);
});

test('failed persistence reloads committed state and drops uncommitted timing', async () => {
  const worker = workerFixture();
  await worker.heartbeat();
  const original = (await worker.request({ type: 'GET_STATE' })).state.chats['chat:abc'].color;
  worker.failNextWrite();
  const failed = await worker.request({ type: 'SET_COLOR', chatId: 'chat:abc', color: '#112233' });
  assert.equal(failed.ok, false);
  const restored = await worker.request({ type: 'GET_STATE' });
  assert.equal(restored.state.chats['chat:abc'].color, original);
  assert.equal(worker.stores.session.compassObservation, undefined);
  worker.advance(5000);
  const result = await worker.heartbeat();
  assert.equal(result.state.chats['chat:abc'].totals.activeMs, 0);
});

test('serialized storage capacity is bounded before Chrome rejects a write', async () => {
  const initial = Compass.defaultState();
  initial.agents.example = { id: 'example', result: '漢'.repeat(2800000) };
  const worker = workerFixture({ local: { compassState: initial }, session: {} });
  const result = await worker.request({ type: 'UPDATE_SETTINGS', settings: { idleSeconds: 90 } });
  assert.equal(result.ok, false);
  assert.match(result.error, /nearly full/);
  assert.equal((await worker.request({ type: 'GET_STATE' })).state.settings.idleSeconds, 60);
});

test('live clocks retain seconds after an hour and across rollovers', () => {
  assert.equal(Compass.formatClock(0), '00:00:00');
  assert.equal(Compass.formatClock(59999), '00:00:59');
  assert.equal(Compass.formatClock(60000), '00:01:00');
  assert.equal(Compass.formatClock(3601000), '01:00:01');
  assert.equal(Compass.formatClock(100 * 3600000 + 61000), '100:01:01');
  assert.equal(Compass.formatClock(-100), '00:00:00');
});

const foreground = { owned: true, visible: true, focused: true };
function projectionFixture(at = 1800000000000, lastActivityAt = at) {
  const chat = Compass.createChat({ id: 'chat:live', title: 'Live', url: 'https://claude.ai/chat/live' }, at);
  const checkpoint = { tabId: 1, chatId: chat.id, at, lastActivityAt, visible: true, focused: true, chatCreatedAt: chat.createdAt, totals: { ...chat.totals } };
  return { chat, checkpoint };
}

test('projection advances each second without mutating the persisted baseline', () => {
  const { chat, checkpoint } = projectionFixture();
  for (let second = 1; second <= 5; second++) {
    const view = Compass.projectChat(chat, checkpoint, checkpoint.at + second * 1000, settings, foreground);
    assert.equal(view.totals.activeMs, second * 1000);
    assert.equal(view.totals.idleMs, 0);
  }
  assert.deepEqual(chat.totals, { activeMs: 0, idleMs: 0 });
  assert.deepEqual(chat.days, {});
});

test('projection reconciles at a heartbeat without doubling or moving backwards', () => {
  const { chat, checkpoint } = projectionFixture();
  const before = Compass.projectChat(chat, checkpoint, checkpoint.at + 7000, settings, foreground);
  Compass.applySegments(chat, Compass.creditInterval(checkpoint, { ...checkpoint, at: checkpoint.at + 5000 }, settings));
  const fresh = { ...checkpoint, at: checkpoint.at + 5000, totals: { ...chat.totals } };
  const after = Compass.projectChat(chat, fresh, checkpoint.at + 7000, settings, foreground);
  assert.equal(before.totals.activeMs, 7000);
  assert.equal(after.totals.activeMs, 7000);
  assert.equal(Compass.projectChat(chat, checkpoint, checkpoint.at + 7000, settings, foreground), chat, 'an old checkpoint cannot attach to newer persisted totals');
});

test('projection obeys owner, focus, pause, chat identity, reset and sleep boundaries', () => {
  const { chat, checkpoint } = projectionFixture();
  const now = checkpoint.at + 5000;
  for (const context of [{ ...foreground, owned: false }, { ...foreground, visible: false }, { ...foreground, focused: false }]) {
    assert.equal(Compass.projectChat(chat, checkpoint, now, settings, context), chat);
  }
  assert.equal(Compass.projectChat(chat, checkpoint, now, { ...settings, paused: true }, foreground), chat);
  assert.equal(Compass.projectChat(chat, { ...checkpoint, chatId: 'chat:other' }, now, settings, foreground), chat);
  assert.equal(Compass.projectChat({ ...chat, createdAt: chat.createdAt + 1 }, checkpoint, now, settings, foreground).totals.activeMs, 0);
  assert.equal(Compass.projectChat(chat, checkpoint, checkpoint.at + 15001, settings, foreground).totals.activeMs, 0);
  assert.equal(Compass.projectChat(chat, checkpoint, checkpoint.at - 1, settings, foreground).totals.activeMs, 0);
});

test('projection splits active/idle transitions and midnight into the correct local days', () => {
  const midnight = new Date(2026, 9, 17).getTime();
  const { chat, checkpoint } = projectionFixture(midnight - 3000, midnight - 61000);
  const view = Compass.projectChat(chat, checkpoint, midnight + 3000, settings, foreground);
  assert.deepEqual(view.days['2026-10-16'], { activeMs: 2000, idleMs: 1000 });
  assert.deepEqual(view.days['2026-10-17'], { activeMs: 0, idleMs: 3000 });
  const resumed = Compass.projectChat(chat, checkpoint, midnight + 3000, settings, { ...foreground, lastActivityAt: midnight + 1000 });
  assert.deepEqual(resumed.days['2026-10-17'], { activeMs: 2000, idleMs: 1000 });
  assert.deepEqual(chat.days, {});
});

test('late response snapshots cannot overwrite a newer timing baseline', () => {
  const current = { epoch: 'current-worker', sequence: 8 };
  const retired = new Set(['retired-worker']);
  assert.equal(Compass.newerSnapshot({ epoch: 'current-worker', sequence: 7 }, current, retired), false);
  assert.equal(Compass.newerSnapshot({ epoch: 'retired-worker', sequence: 1000 }, current, retired), false);
  assert.equal(Compass.newerSnapshot({ epoch: 'current-worker', sequence: 9 }, current, retired), true);
  assert.equal(Compass.newerSnapshot({ epoch: 'new-worker-after-clock-rollback', sequence: 1 }, current, retired), true);
  assert.equal(Compass.newerSnapshot(null, current), false);
});

test('legacy state gets system appearance without writing on reads; theme validation persists explicit choices', async () => {
  const legacy = Compass.defaultState();
  delete legacy.settings.theme;
  const worker = workerFixture({ local: { compassState: legacy }, session: {} });
  assert.equal((await worker.request({ type: 'GET_STATE' })).state.settings.theme, 'system');
  assert.equal(worker.writes, 0);
  assert.equal((await worker.request({ type: 'UPDATE_SETTINGS', settings: { theme: 'dark' } })).state.settings.theme, 'dark');
  assert.equal(worker.stores.local.compassState.settings.theme, 'dark');
  assert.equal((await worker.request({ type: 'UPDATE_SETTINGS', settings: { theme: 'invalid' } })).ok, false);
  assert.equal((await worker.request({ type: 'GET_STATE' })).state.settings.theme, 'dark');
});

test('appearance and report preferences preserve timing ownership and atomic response checkpoints', async () => {
  const worker = workerFixture();
  const first = await worker.heartbeat();
  assert.equal(first.timing.ownedBySender, true);
  assert.deepEqual(first.timing.totals, first.state.chats['chat:abc'].totals);
  worker.advance(2500);
  await worker.request({ type: 'UPDATE_SETTINGS', settings: { theme: 'dark', updateMinutes: 0 } });
  worker.advance(2500);
  const result = await worker.heartbeat();
  assert.equal(result.state.chats['chat:abc'].totals.activeMs, 5000);
  assert.equal(result.timing.at, worker.now);
  assert.deepEqual(result.timing.totals, { activeMs: 5000, idleMs: 0 });
  assert.equal(result.state.settings.theme, 'dark');
  assert.ok(Compass.newerSnapshot(result.snapshot, first.snapshot));
  const writes = worker.writes;
  const snapshot = await worker.request({ type: 'GET_STATE' });
  assert.equal(snapshot.timing.ownedBySender, false, 'extension dashboard is not the active Claude tab');
  assert.equal(worker.writes, writes);
});

test('browser tab and window focus override stale foreground claims from page JavaScript', async () => {
  const worker = workerFixture();
  await worker.heartbeat();
  worker.advance(2000);
  worker.hooks.activated({ tabId: 2, windowId: 1 });
  await worker.request({ type: 'GET_STATE' });
  worker.advance(3000);
  let result = await worker.heartbeat('abc', { active: false, visible: true, focused: true });
  assert.equal(result.foregroundEligible, false);
  assert.equal(result.state.chats['chat:abc'].totals.activeMs, 2000);
  worker.advance(5000);
  result = await worker.heartbeat('abc', { active: false });
  assert.equal(result.state.chats['chat:abc'].totals.activeMs, 2000);
  worker.setWindowFocused(false);
  result = await worker.heartbeat('abc', { active: true });
  assert.equal(result.foregroundEligible, false);
  assert.equal(result.timing, null);
  worker.setWindowFocused(true);
  result = await worker.heartbeat('abc');
  assert.equal(result.foregroundEligible, true);
  assert.equal(result.timing.ownedBySender, true);
  worker.advance(1000);
  result = await worker.heartbeat('abc');
  assert.equal(result.state.chats['chat:abc'].totals.activeMs, 3000);
});
