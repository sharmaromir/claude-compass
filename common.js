(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Compass = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PALETTE = ['#8b78e6', '#3fa7a0', '#e69a50', '#d86e9a', '#6d96df', '#96a655', '#bf805a', '#9b83bd'];
  const MAX_HEARTBEAT_GAP_MS = 15000;

  function defaultState() {
    return { version: 1, settings: { idleSeconds: 60, updateMinutes: 15, paused: false, theme: 'system' }, chats: {}, agents: {}, reports: [] };
  }

  function chatFromUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'claude.ai' || url.port) return null;
      const match = url.pathname.match(/^\/(chat|code)\/([a-zA-Z0-9_-]{1,160})\/?$/);
      if (!match || match[2].toLowerCase() === 'new') return null;
      return { id: `${match[1]}:${match[2]}`, url: `https://claude.ai/${match[1]}/${match[2]}` };
    } catch (_) { return null; }
  }

  function colorForId(id) {
    let hash = 2166136261;
    for (const character of String(id)) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return PALETTE[(hash >>> 0) % PALETTE.length];
  }

  function formatDuration(value) {
    const seconds = Math.floor(Math.max(0, Number(value) || 0) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ''}`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
  }

  function formatClock(value) {
    const seconds = Math.floor(Math.max(0, Number(value) || 0) / 1000);
    return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function dayKey(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError('Invalid date');
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function createChat(input, at = Date.now()) {
    return {
      id: input.id, title: input.title || 'Untitled chat', url: input.url,
      color: colorForId(input.id), createdAt: at, updatedAt: at,
      totals: { activeMs: 0, idleMs: 0 }, days: {}
    };
  }

  function summarizeChat(chat) {
    const active = Math.max(0, Number(chat?.totals?.activeMs) || 0);
    const idle = Math.max(0, Number(chat?.totals?.idleMs) || 0);
    const percent = active + idle ? Math.round(active / (active + idle) * 100) : 0;
    return `${chat?.title || 'Untitled chat'}: ${formatDuration(active)} active, ${formatDuration(idle)} idle${active + idle ? ` (${percent}% active)` : ''}.`;
  }

  // Credit only a continuously observed foreground interval. A later activity
  // timestamp can start a new active segment, but cannot make earlier idle time active.
  function creditInterval(previous, next, settings) {
    if (!previous || !next || settings.paused || !previous.visible || !previous.focused) return [];
    const start = Number(previous.at);
    const end = Number(next.at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > MAX_HEARTBEAT_GAP_MS) return [];
    const idleMs = Math.max(1, Number(settings.idleSeconds) || 60) * 1000;
    const previousActivity = Number(previous.lastActivityAt) || 0;
    const sameChat = next.chatId === previous.chatId && next.tabId === previous.tabId;
    const nextActivity = sameChat ? Number(next.lastActivityAt) || 0 : previousActivity;
    const newActivity = nextActivity > previousActivity && nextActivity <= end ? nextActivity : null;
    const boundaries = [start, end];
    const previousCutoff = previousActivity + idleMs;
    if (previousCutoff > start && previousCutoff < end) boundaries.push(previousCutoff);
    if (newActivity !== null) {
      if (newActivity > start && newActivity < end) boundaries.push(newActivity);
      if (newActivity + idleMs > start && newActivity + idleMs < end) boundaries.push(newActivity + idleMs);
    }
    const points = [...new Set(boundaries)].sort((a, b) => a - b);
    return points.slice(0, -1).map((at, index) => ({
      start: at,
      end: points[index + 1],
      kind: at < previousCutoff || (newActivity !== null && at >= newActivity && at < newActivity + idleMs) ? 'activeMs' : 'idleMs'
    })).filter(segment => segment.end > segment.start);
  }

  function applySegments(chat, segments) {
    let credited = 0;
    for (const segment of segments) {
      if (!['activeMs', 'idleMs'].includes(segment.kind) || segment.end <= segment.start) continue;
      let cursor = segment.start;
      while (cursor < segment.end) {
        const date = new Date(cursor);
        const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
        const until = Math.min(segment.end, midnight);
        const duration = until - cursor;
        const key = dayKey(date);
        chat.days[key] ||= { activeMs: 0, idleMs: 0 };
        chat.days[key][segment.kind] += duration;
        chat.totals[segment.kind] += duration;
        credited += duration;
        cursor = until;
      }
      chat.updatedAt = Math.max(chat.updatedAt, segment.end);
    }
    return credited;
  }

  // A checkpoint and its persisted totals form one snapshot. Project only from
  // that exact baseline: attaching it to newer totals would count time twice.
  function projectChat(chat, checkpoint, now, settings, context = {}) {
    if (!chat || !checkpoint || settings.paused || context.owned !== true || context.visible !== true || context.focused !== true ||
        checkpoint.chatId !== chat.id || checkpoint.chatCreatedAt !== chat.createdAt ||
        checkpoint.totals?.activeMs !== chat.totals.activeMs || checkpoint.totals?.idleMs !== chat.totals.idleMs) return chat;
    const projected = { ...chat, totals: { ...chat.totals }, days: Object.fromEntries(Object.entries(chat.days).map(([key, totals]) => [key, { ...totals }])) };
    const next = { ...checkpoint, at: now, lastActivityAt: context.lastActivityAt ?? checkpoint.lastActivityAt };
    applySegments(projected, creditInterval(checkpoint, next, settings));
    return projected;
  }

  function newerSnapshot(next, previous, retiredEpochs = new Set()) {
    if (!next || typeof next.epoch !== 'string' || !next.epoch || !Number.isFinite(next.sequence)) return false;
    if (!previous) return true;
    return next.epoch === previous.epoch ? next.sequence >= previous.sequence : !retiredEpochs.has(next.epoch);
  }

  return { PALETTE, MAX_HEARTBEAT_GAP_MS, defaultState, chatFromUrl, colorForId, formatDuration, formatClock, dayKey, createChat, summarizeChat, creditInterval, applySegments, projectChat, newerSnapshot };
});
