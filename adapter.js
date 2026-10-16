/* All Claude DOM assumptions live here. Never infer agents from ordinary chat prose. */
(function (root) {
  'use strict';
  const C = root.Compass;
  const text = (value, max = 500) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const statuses = new Map([
    ['running', 'running'], ['in progress', 'running'], ['in_progress', 'running'], ['working', 'running'],
    ['pending', 'unknown'], ['queued', 'unknown'], ['completed', 'completed'], ['complete', 'completed'],
    ['done', 'completed'], ['success', 'completed'], ['succeeded', 'completed'], ['failed', 'failed'],
    ['error', 'failed'], ['cancelled', 'failed'], ['canceled', 'failed']
  ]);
  const visible = el => el && !el.closest('[hidden], [aria-hidden="true"]') && el.getClientRects().length > 0;
  const normalizeStatus = value => statuses.get(text(value, 60).toLowerCase()) || 'unknown';

  function currentChat(doc = document, url = location.href) {
    const chat = C.chatFromUrl(url);
    if (!chat) return null;
    const anchor = Array.from(doc.querySelectorAll('a[href]')).find(a => C.chatFromUrl(a.href)?.id === chat.id && !a.closest('#compass-root'));
    const heading = doc.querySelector('main h1, [data-testid="chat-title"], [data-testid="conversation-title"]');
    const title = text(anchor?.getAttribute('title') || anchor?.textContent || heading?.textContent || doc.title.replace(/\s*[-|–]\s*Claude.*$/i, ''), 160);
    return {...chat, title: title && !/^claude$/i.test(title) ? title : 'Untitled chat'};
  }

  function composer(doc = document) {
    const candidates = doc.querySelectorAll('[contenteditable="true"][role="textbox"], .ProseMirror[contenteditable="true"], [contenteditable="true"][data-placeholder], textarea[placeholder]');
    return Array.from(candidates).find(el => visible(el) && !el.closest('#compass-root, [role="dialog"], nav, aside')) || null;
  }

  function composerShell(editor) {
    const shell = editor?.closest('.rounded-composer, [data-testid="chat-input-container"]');
    // The editable node may be only one line high. Outline only a recognized
    // native container so the cue surrounds the complete composer and controls.
    return shell && shell !== editor && visible(shell) ? shell : null;
  }

  function agents(doc = document) {
    // Require structural agent metadata. Broad text matching would mistake assistant prose for telemetry.
    const candidates = doc.querySelectorAll('[data-subagent-id], [data-agent-id], [data-testid="subagent-card"], [data-testid="agent-card"], [data-testid="tool-call"][data-tool-name="Agent"], [data-testid="tool-call"][data-tool-name="Task"]');
    const found = new Map();
    for (const card of candidates) {
      if (card.closest('#compass-root, [contenteditable="true"], pre, code, [data-testid="user-message"]')) continue;
      const id = text(card.getAttribute('data-subagent-id') || card.getAttribute('data-agent-id') || card.getAttribute('data-tool-use-id') || card.getAttribute('data-tool-id') || card.id, 160);
      // Do not fabricate a stable identity from names: repeated invocations can share a name.
      if (!id) continue;
      const nameNode = card.querySelector('[data-agent-name], [data-testid="agent-name"], [data-testid="subagent-name"], [data-testid="tool-title"]');
      const name = text(card.getAttribute('data-agent-name') || nameNode?.getAttribute('data-agent-name') || nameNode?.textContent || card.getAttribute('aria-label') || 'Observed agent', 120);
      const statusNode = card.querySelector('[data-agent-status], [data-testid="agent-status"], [role="status"]');
      const status = normalizeStatus(card.getAttribute('data-agent-status') || card.getAttribute('data-status') || statusNode?.getAttribute('data-agent-status') || statusNode?.textContent);
      const resultNode = card.querySelector('[data-agent-result], [data-testid="agent-result"], [data-testid="tool-result"], [data-testid="subagent-result"]');
      const result = String(card.getAttribute('data-agent-result') || resultNode?.textContent || '').trim().slice(0, 12000);
      found.set(id, {id, name, status, result});
    }
    return Array.from(found.values()).slice(0, 100);
  }
  root.CompassAdapter = {currentChat, composer, composerShell, agents, normalizeStatus};
})(globalThis);
