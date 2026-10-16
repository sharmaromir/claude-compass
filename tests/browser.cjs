#!/usr/bin/env node
'use strict';

// Install the optional test dependency with `npm install --no-save playwright`.
// Then run `npx playwright install chromium` and `node tests/browser.cjs`.
// Uses a disposable browser profile and intercepts all web traffic with Demo fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const extensionPath = path.resolve(__dirname, '..');
const previewDirectory = process.env.COMPASS_PREVIEW_DIR ? path.resolve(process.env.COMPASS_PREVIEW_DIR) : path.resolve(extensionPath, '..');
fs.mkdirSync(previewDirectory, { recursive: true });
const fixture = fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8');
const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-compass-test-'));
const results = [];
const errors = [];
let context;
let extensionId;
let worker;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check, label, timeout = 12000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try { last = await check(); if (last) return last; } catch (error) { last = error.message; }
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}. Last value: ${JSON.stringify(last)}`);
}
async function test(name, fn) {
  const started = Date.now();
  await fn();
  results.push({ name, passed: true, elapsedMs: Date.now() - started });
  console.log(`PASS ${name}`);
}
async function state() {
  return worker.evaluate(async () => (await chrome.storage.local.get('compassState')).compassState);
}
async function api(page, message) {
  const result = await page.evaluate(message => chrome.runtime.sendMessage(message), message);
  assert.equal(result?.ok, true, result?.error || 'Extension API did not respond');
  return result;
}
function total(chat) { return (chat?.totals.activeMs || 0) + (chat?.totals.idleMs || 0); }
function clockMs(value) {
  const clock = String(value).trim().match(/^(\d+):(\d{2}):(\d{2})$/);
  assert.ok(clock, `Expected a live HH:MM:SS timer, got ${JSON.stringify(value)}`);
  return (Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])) * 1000;
}
async function clockSnapshot(page) {
  return page.locator('#compass-root').evaluate(host => {
    const shadow = host.shadowRoot;
    return { active: shadow.querySelector('.active').textContent, idle: shadow.querySelector('.idle').textContent, status: shadow.querySelector('.status').textContent };
  });
}
async function sampleClock(page, durationMs) {
  const samples = [];
  const start = Date.now();
  while (Date.now() - start < durationMs) {
    const clock = await clockSnapshot(page);
    const saved = (await state()).chats['chat:demo-launch'];
    samples.push({ elapsed: Date.now() - start, active: clockMs(clock.active), idle: clockMs(clock.idle), persisted: total(saved) });
    await sleep(250);
  }
  return samples;
}
function assertMonotonic(samples, key) {
  samples.slice(1).forEach((sample, index) => assert.ok(sample[key] >= samples[index][key], `${key} timer moved backwards at sample ${index}: ${JSON.stringify(samples.slice(Math.max(0, index - 1), index + 2))}`));
}
async function resolvedTheme(page, selector = 'html') { return page.locator(selector).getAttribute('data-theme'); }
async function expectTheme(page, theme, selector = 'html') { await eventually(async () => (await resolvedTheme(page, selector)) === theme, `${selector} resolves to ${theme}`); }
async function noHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({ width: innerWidth, root: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(metrics.root <= metrics.width + 1 && metrics.body <= metrics.width + 1, `${label} overflows: ${JSON.stringify(metrics)}`);
}
async function screenshot(page, name) {
  const destination = path.join(previewDirectory, name);
  await page.screenshot({ path: destination, fullPage: true });
  console.log(`PREVIEW ${destination}`);
}

async function run() {
  context = await chromium.launchPersistentContext(profilePath, {
    channel: 'chromium', headless: true,
    viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1, acceptDownloads: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  context.on('page', page => page.on('pageerror', error => errors.push(`${page.url()}: ${error.message}`)));
  await context.route(/^https?:\/\//, async route => {
    const url = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: 'text/html', body: url.hostname === 'claude.ai' ? fixture : '<!doctype html><title>Demo unrelated site</title><h1>Demo unrelated site</h1>' });
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
  await worker.evaluate(() => {
    globalThis.compassTestMessages = [];
    chrome.runtime.onMessage.addListener((message, sender) => {
      globalThis.compassTestMessages.push({ type: message.type, chatId: message.chat?.id, url: sender.url, tabUrl: sender.tab?.url, active: sender.tab?.active, visible: message.visible, focused: message.focused });
      if (globalThis.compassTestMessages.length > 40) globalThis.compassTestMessages.shift();
    });
  });
  const page = await context.newPage();
  await page.goto('https://claude.ai/chat/demo-launch');
  await page.bringToFront();
  await page.locator('#compass-root').waitFor();
  await eventually(async () => (await state())?.chats['chat:demo-launch'], 'initial chat registration');
  const dashboard = await context.newPage();
  await dashboard.goto(`chrome-extension://${extensionId}/dashboard.html`);
  await dashboard.waitForLoadState('domcontentloaded');

  await test('Claude-only injection; fixture chat identity and composer cue appear', async () => {
    assert.equal(await page.locator('#compass-root').count(), 1);
    assert.ok(await page.locator('[data-compass-composer]').count(), 'Composer color cue missing');
    assert.ok(await page.locator('[data-compass-chat]').count(), 'Sidebar color cues missing');
    const unrelated = await context.newPage();
    await unrelated.goto('https://example.com/demo');
    await sleep(300);
    assert.equal(await unrelated.locator('#compass-root').count(), 0);
    await unrelated.close();
  });

  await test('Normal assistant prose never creates agent records', async () => {
    await page.bringToFront();
    await sleep(750);
    assert.equal(Object.keys((await state()).agents).length, 0);
  });

  await test('Composer identity label follows the editor and clears its absolute placeholder', async () => {
    const layout = await page.evaluate(() => {
      const editor = document.querySelector('[contenteditable="true"]');
      const shell = document.querySelector('[data-compass-composer]');
      const label = document.querySelector('#compass-composer-label');
      const placeholder = document.querySelector('.editor-placeholder');
      const controls = document.querySelector('.composer footer');
      const shellRect = shell.getBoundingClientRect();
      const editorRect = editor.getBoundingClientRect();
      const controlsRect = controls.getBoundingClientRect();
      return {
        followsEditor: label.previousSibling === editor,
        labelTop: label.getBoundingClientRect().top,
        editorBottom: editor.getBoundingClientRect().bottom,
        placeholderBottom: placeholder.getBoundingClientRect().bottom,
        placeholderVisible: getComputedStyle(placeholder).display !== 'none',
        outlineOffset: getComputedStyle(shell).outlineOffset,
        shellContainsEditor: shell !== editor && shell.contains(editor),
        shellContainsControls: shell.contains(controls),
        nativeRadius: getComputedStyle(shell).borderRadius,
        editorOutline: getComputedStyle(editor).outlineStyle,
        enclosesEditor: shellRect.top <= editorRect.top && shellRect.left <= editorRect.left && shellRect.right >= editorRect.right && shellRect.bottom >= editorRect.bottom,
        enclosesControls: shellRect.top <= controlsRect.top && shellRect.left <= controlsRect.left && shellRect.right >= controlsRect.right && shellRect.bottom >= controlsRect.bottom,
        markerCount: document.querySelectorAll('[data-compass-composer]').length
      };
    });
    assert.equal(layout.followsEditor, true, 'Identity label must follow the editable element');
    assert.equal(layout.placeholderVisible, true, 'Fixture must exercise an empty composer with a visible placeholder');
    assert.ok(layout.labelTop >= layout.editorBottom, 'Label must sit below the editor');
    assert.ok(layout.labelTop >= layout.placeholderBottom, 'Label must not overlap the absolute placeholder');
    assert.ok(parseFloat(layout.outlineOffset) <= 0, 'Outline should follow the outside shell border');
    assert.equal(layout.markerCount, 1, 'Only one composer shell should be highlighted');
    assert.ok(layout.shellContainsEditor && layout.shellContainsControls && layout.enclosesEditor && layout.enclosesControls, 'The color outline must enclose the input and its controls');
    assert.equal(layout.nativeRadius, '20px', 'Preserve the fixture shell’s native radius');
    assert.equal(layout.editorOutline, 'none', 'Do not leave a second outline on the editable area');
  });

  await test('Native nested composer shells retain their radius, survive replacement, and skip unknown wrappers', async () => {
    const typed = 'Demo text remains untouched while the composer shell changes.';
    await page.locator('[contenteditable]').fill(typed);
    await page.evaluate(() => {
      const form = document.querySelector('form');
      form.removeAttribute('data-testid');
      form.classList.remove('composer');
      const shell = document.createElement('div');
      shell.className = 'composer rounded-composer bg-surface-3 shadow-composer';
      shell.dataset.demoShell = 'first';
      while (form.firstChild) shell.append(form.firstChild);
      form.append(shell);
      const outside = document.createElement('div');
      outside.className = 'demo-outside-toolbar';
      outside.textContent = 'Demo model controls outside the composer';
      form.append(outside);
    });
    await eventually(() => page.locator('[data-demo-shell="first"][data-compass-composer]').count(), 'native rounded composer shell receives the outline');
    let geometry = await page.evaluate(() => {
      const shell = document.querySelector('[data-compass-composer]');
      const editor = document.querySelector('[contenteditable]');
      const controls = document.querySelector('[data-demo-send]');
      const outside = document.querySelector('.demo-outside-toolbar');
      const box = shell.getBoundingClientRect();
      const button = controls.getBoundingClientRect();
      return { radius: getComputedStyle(shell).borderRadius, editorOutline: getComputedStyle(editor).outlineStyle, containsControls: shell.contains(controls), containsOutside: shell.contains(outside), controlsBottom: button.bottom, shellBottom: box.bottom, outsideTop: outside.getBoundingClientRect().top, markerCount: document.querySelectorAll('[data-compass-composer]').length };
    });
    assert.equal(geometry.radius, '14px', 'Keep the native rounded-composer radius');
    assert.equal(geometry.editorOutline, 'none');
    assert.equal(geometry.markerCount, 1);
    assert.equal(geometry.containsControls, true);
    assert.equal(geometry.containsOutside, false, 'Do not expand the outline onto the outside toolbar');
    assert.ok(geometry.controlsBottom <= geometry.shellBottom && geometry.shellBottom <= geometry.outsideTop);
    assert.equal(await page.locator('[contenteditable]').innerText(), typed);
    await page.locator('[data-demo-send]').click();
    await page.locator('[data-demo-attach]').click();
    assert.deepEqual(await page.evaluate(() => [window.demoSendClicks, window.demoAttachClicks]), [1, 1], 'Shell decoration must not intercept native controls');
    assert.equal(await page.locator('[contenteditable]').innerText(), typed);

    await page.evaluate(() => {
      const previous = document.querySelector('[data-demo-shell="first"]');
      const replacement = document.createElement('div');
      replacement.className = 'composer rounded-composer bg-surface-3 shadow-composer';
      replacement.dataset.demoShell = 'replacement';
      while (previous.firstChild) replacement.append(previous.firstChild);
      previous.after(replacement);
    });
    await eventually(() => page.locator('[data-demo-shell="replacement"][data-compass-composer]').count(), 'replacement shell receives outline');
    assert.equal(await page.locator('[data-demo-shell="first"]').getAttribute('data-compass-composer'), null, 'Old shell marker must be cleared');
    assert.equal(await page.locator('[data-compass-composer]').count(), 1);
    assert.equal(await page.locator('#compass-composer-label').count(), 1);

    await page.evaluate(() => {
      const shell = document.querySelector('[data-demo-shell="replacement"]');
      shell.classList.remove('rounded-composer');
      // A matching class on the editable itself must never create the old tiny box.
      document.querySelector('[contenteditable]').classList.add('rounded-composer');
      shell.append(document.createComment('Demo unknown shell rerender'));
    });
    await eventually(async () => (await page.locator('[data-compass-composer]').count()) === 0, 'unknown shell omits outline instead of highlighting only the input');
    assert.equal(await page.locator('#compass-composer-label').count(), 1, 'Destination identity remains useful without a known shell');
    assert.equal(await page.locator('[contenteditable]').innerText(), typed);

    await page.evaluate(() => {
      const form = document.querySelector('form');
      const shell = document.querySelector('[data-demo-shell="replacement"]');
      document.querySelector('[contenteditable]').classList.remove('rounded-composer');
      const editorWrap = shell.querySelector('.editor-wrap');
      const footer = shell.querySelector('footer');
      form.replaceChildren(editorWrap, footer);
      form.className = 'composer';
      form.dataset.testid = 'chat-input-container';
    });
    await eventually(() => page.locator('form[data-compass-composer]').count(), 'original known fixture shell restored');
    await page.locator('[contenteditable]').fill('');
  });

  await test('Custom chat color persists through SPA navigation and reload', async () => {
    await api(dashboard, { type: 'SET_COLOR', chatId: 'chat:demo-launch', color: '#24718e' });
    await page.locator('nav a[href="/chat/demo-research"]').click();
    await eventually(async () => (await state()).chats['chat:demo-research'], 'SPA second chat registration');
    assert.notEqual((await state()).chats['chat:demo-research'].color, '#24718e');
    await page.locator('nav a[href="/chat/demo-launch"]').click();
    await sleep(500);
    await page.reload();
    await page.locator('#compass-root').waitFor();
    assert.equal((await state()).chats['chat:demo-launch'].color, '#24718e');
    assert.ok(await page.locator('[data-compass-composer]').count());
    await eventually(() => page.locator('#compass-root').evaluate(el => el.style.getPropertyValue('--accent') === '#24718e'), 'persisted color on identity badge');
    assert.equal(await page.locator('html').evaluate(el => el.style.getPropertyValue('--compass-color')), '#24718e');
    assert.match(await page.locator('#compass-composer-label').innerText(), /Demo · Launch planning/);
  });

  await test('Structured running agent becomes one completed entry with its result', async () => {
    await page.evaluate(() => window.demoAgent('running'));
    await eventually(async () => Object.values((await state()).agents).some(agent => agent.status === 'running'), 'running agent detection');
    await page.evaluate(() => window.demoAgent('completed', 'Demo result: reviewed three source documents and recorded the next action.'));
    await eventually(async () => Object.values((await state()).agents).some(agent => agent.status === 'completed' && agent.result.includes('three source documents')), 'completed agent result detection');
    const observed = Object.values((await state()).agents);
    assert.equal(observed.length, 1, 'Agent update should deduplicate by ID');
    assert.equal(observed[0].chatId, 'chat:demo-launch');
    assert.equal(observed[0].source, 'observed');
  });

  await test('Collapsed results persist; equal agent names with distinct IDs remain separate', async () => {
    await page.evaluate(() => {
      const original = document.querySelector('[data-agent-id="demo-research-agent"]');
      original.removeAttribute('data-agent-result');
      original.removeAttribute('data-result');
      original.dataset.agentStatus = 'unknown';
      original.querySelector('[data-testid="agent-result"]').remove();
      const additional = document.createElement('section');
      additional.className = 'agent-card';
      additional.dataset.agentId = 'demo-second-agent';
      additional.dataset.agentName = original.dataset.agentName;
      additional.dataset.agentStatus = 'not-a-recognized-state';
      additional.textContent = 'Demo · Source research · status not exposed';
      document.querySelector('#agent-container').append(additional);
      const code = document.createElement('pre');
      const example = document.createElement('span');
      example.dataset.agentId = 'demo-code-example-not-telemetry';
      example.dataset.agentName = 'Demo code example';
      example.dataset.agentStatus = 'running';
      example.textContent = 'Demo: markup inside code is not agent telemetry.';
      code.append(example);
      document.querySelector('#agent-container').append(code);
    });
    await eventually(async () => Object.values((await state()).agents).length === 2, 'second agent with distinct identity');
    const agents = Object.values((await state()).agents);
    const original = agents.find(agent => agent.id.endsWith(':demo-research-agent'));
    const other = agents.find(agent => agent.id.endsWith(':demo-second-agent'));
    assert.equal(original.status, 'completed', 'An ambiguous later card must not erase completion');
    assert.match(original.result, /three source documents/, 'Collapsing the card must preserve its result');
    assert.equal(other.status, 'unknown');
    assert.equal(other.name, original.name);
    assert.equal(agents.length, 2, 'Code snippets must not become agent records');
    await page.evaluate(() => {
      document.querySelector('[data-agent-id="demo-second-agent"]').remove();
      document.querySelector('#agent-container pre').remove();
      window.demoAgent('completed', 'Demo result: reviewed three source documents and recorded the next action.');
    });
    await sleep(500);
    const chatPreview = process.env.COMPASS_CHAT_PREVIEW_PATH || path.join(previewDirectory, 'claude-compass-chat-preview.png');
    await page.screenshot({ path: chatPreview, fullPage: true });
    console.log(`CHAT_PREVIEW ${chatPreview}`);
  });

  await test('Foreground activity counts and background tabs do not keep counting', async () => {
    await page.bringToFront();
    await page.locator('[contenteditable]').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Demo activity.');
    const before = total((await state()).chats['chat:demo-launch']);
    await eventually(async () => total((await state()).chats['chat:demo-launch']) > before + 500, 'foreground time accrual', 12000);
    const unrelated = await context.newPage();
    await unrelated.goto('https://example.com/demo');
    await unrelated.bringToFront();
    await sleep(700);
    const stopped = total((await state()).chats['chat:demo-launch']);
    await sleep(5500);
    assert.equal(total((await state()).chats['chat:demo-launch']), stopped, 'Background time must not accumulate');
    await unrelated.close();
  });

  await test('Dashboard and popup load with persisted chats and no script errors', async () => {
    await dashboard.bringToFront();
    await dashboard.reload();
    await eventually(async () => (await dashboard.locator('body').innerText()).includes('Demo · Launch planning'), 'dashboard chat list');
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.waitForLoadState('domcontentloaded');
    await sleep(300);
    assert.ok((await popup.locator('body').innerText()).trim().length > 20);
    await popup.close();
    assert.deepEqual(errors, []);
  });

  await test('Explicit dark and light themes propagate across dashboard, popup, and chat and survive reload', async () => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await dashboard.bringToFront();
    await dashboard.locator('[data-page="settings"]').click();
    for (const theme of ['dark', 'light']) {
      const previousPreference = (await state()).settings.theme;
      await dashboard.locator('#theme-setting').selectOption(theme);
      await expectTheme(dashboard, theme);
      assert.equal((await state()).settings.theme, previousPreference, 'Appearance preview should not persist before Save');
      await dashboard.locator('#settings-form [type="submit"]').click();
      await eventually(async () => (await state()).settings.theme === theme, `${theme} preference persists`);
      await expectTheme(dashboard, theme);
      await expectTheme(popup, theme);
      await expectTheme(page, theme, '#compass-root');
      await dashboard.reload();
      await popup.reload();
      await page.reload();
      await expectTheme(dashboard, theme);
      await expectTheme(popup, theme);
      await expectTheme(page, theme, '#compass-root');
      await dashboard.locator('[data-page="settings"]').click();
      assert.equal(await dashboard.locator('#theme-setting').inputValue(), theme);
    }
    await popup.close();
  });

  await test('System theme responds to media changes and explicit choice overrides the system', async () => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await api(dashboard, { type: 'UPDATE_SETTINGS', settings: { theme: 'system' } });
    for (const theme of ['dark', 'light']) {
      await Promise.all([dashboard.emulateMedia({ colorScheme: theme }), popup.emulateMedia({ colorScheme: theme }), page.emulateMedia({ colorScheme: theme })]);
      await expectTheme(dashboard, theme);
      await expectTheme(popup, theme);
      await expectTheme(page, theme, '#compass-root');
      assert.equal((await state()).settings.theme, 'system');
    }
    await api(dashboard, { type: 'UPDATE_SETTINGS', settings: { theme: 'dark' } });
    await expectTheme(dashboard, 'dark');
    await expectTheme(popup, 'dark');
    await expectTheme(page, 'dark', '#compass-root');
    await api(dashboard, { type: 'UPDATE_SETTINGS', settings: { theme: 'light' } });
    await popup.close();
  });

  await test('Live active timer ticks between heartbeats and stays monotonic without double counting', async () => {
    await api(dashboard, { type: 'UPDATE_SETTINGS', settings: { idleSeconds: 60, paused: false } });
    await page.bringToFront();
    await page.locator('[contenteditable]').click();
    await page.keyboard.type('Demo live timer.');
    await sleep(500);
    const samples = await sampleClock(page, 11000);
    assertMonotonic(samples, 'active');
    assertMonotonic(samples, 'idle');
    assert.ok(new Set(samples.map(sample => sample.active)).size >= 8, 'Active clock should visibly change about once per second');
    assert.ok(samples.some((sample, index) => index > 0 && sample.persisted === samples[index - 1].persisted && sample.active > samples[index - 1].active), 'UI must tick between durable heartbeat writes');
    const elapsed = samples.at(-1).elapsed - samples[0].elapsed;
    const displayed = samples.at(-1).active + samples.at(-1).idle - samples[0].active - samples[0].idle;
    const transitions = samples.filter((sample, index) => index === 0 || sample.active !== samples[index - 1].active || sample.idle !== samples[index - 1].idle || sample.persisted !== samples[index - 1].persisted);
    assert.ok(displayed >= elapsed - 2000 && displayed <= elapsed + 2000, `Displayed ${displayed}ms for ${elapsed}ms elapsed. Transitions: ${JSON.stringify(transitions)}`);
    for (const sample of samples) assert.ok(sample.active + sample.idle <= sample.persisted + 6500, `Projection was counted twice: ${JSON.stringify(sample)}`);
  });

  await test('A focused quiet chat becomes idle, and pausing stops its clock', async () => {
    await api(dashboard, { type: 'UPDATE_SETTINGS', settings: { idleSeconds: 15 } });
    await page.bringToFront();
    await page.locator('[contenteditable]').click();
    const idleBefore = (await state()).chats['chat:demo-launch'].totals.idleMs;
    await eventually(async () => (await state()).chats['chat:demo-launch'].totals.idleMs > idleBefore + 500, 'foreground inactivity classified as idle', 25000);
    const idleSamples = await sampleClock(page, 3500);
    assertMonotonic(idleSamples, 'active');
    assertMonotonic(idleSamples, 'idle');
    assert.ok(idleSamples.at(-1).idle - idleSamples[0].idle >= 2000, 'Idle display should also tick each second');
    await api(dashboard, { type: 'UPDATE_SETTINGS', settings: { paused: true } });
    const paused = total((await state()).chats['chat:demo-launch']);
    await eventually(async () => (await clockSnapshot(page)).status.toLowerCase().includes('paused'), 'paused label');
    const pausedClock = await clockSnapshot(page);
    await page.keyboard.type(' Demo paused interaction.');
    await sleep(5500);
    assert.equal(total((await state()).chats['chat:demo-launch']), paused, 'Pause must stop activity and idle accumulation');
    const afterPausedClock = await clockSnapshot(page);
    assert.equal(afterPausedClock.active, pausedClock.active);
    assert.equal(afterPausedClock.idle, pausedClock.idle);
    await api(dashboard, { type: 'UPDATE_SETTINGS', settings: { paused: false } });
  });

  await test('Productivity updates are stored inside extension and include copyable text', async () => {
    const response = await api(dashboard, { type: 'CREATE_REPORT', chatId: 'chat:demo-launch' });
    assert.match(response.report.text, /Demo · Launch planning/);
    assert.match(response.report.text, /active.*idle/);
    assert.ok((await state()).reports.some(report => report.id === response.report.id));
  });

  await test('Mailbox shows results, filters status, and saves a manual entry', async () => {
    await dashboard.bringToFront();
    await dashboard.locator('[data-page="mailbox"]').click();
    await dashboard.locator('#mailbox-status').selectOption('completed');
    await eventually(async () => (await dashboard.locator('#agents-list').innerText()).includes('three source documents'), 'observed result visible in mailbox');
    assert.equal(await dashboard.locator('#agents-list .agent-card').count(), 1);
    assert.equal(await dashboard.locator('#agents-list').getByRole('button', { name: 'Edit', exact: true }).count(), 0, 'Observed records should not pretend to be manually editable');
    await dashboard.getByRole('button', { name: 'Mark as read', exact: true }).click();
    await eventually(async () => Object.values((await state()).agents).find(agent => agent.id.endsWith(':demo-research-agent'))?.read, 'mark read persists');
    await dashboard.locator('#add-agent').click();
    await dashboard.locator('#agent-name').fill('Demo · Manual planning assistant');
    await dashboard.locator('#agent-chat').selectOption('chat:demo-research');
    await dashboard.locator('#agent-status').selectOption('completed');
    await dashboard.locator('#agent-result').fill('Demo manual result: next steps are ready for review.');
    await dashboard.locator('#agent-form [type="submit"]').click();
    await eventually(async () => Object.values((await state()).agents).some(agent => agent.name === 'Demo · Manual planning assistant' && agent.chatId === 'chat:demo-research' && agent.source === 'manual'), 'manual agent persisted to selected chat');
    await dashboard.locator('#mailbox-chat').selectOption('chat:demo-research');
    assert.match(await dashboard.locator('#agents-list').innerText(), /next steps are ready/);
    await dashboard.getByRole('button', { name: 'Edit', exact: true }).click();
    assert.equal(await dashboard.locator('#agent-chat').isDisabled(), true, 'Editing an agent must retain its original conversation');
    await dashboard.locator('#agent-result').fill('Demo manual result: next steps are ready for review.\nRevision: checked the launch checklist.');
    await dashboard.locator('#agent-form [type="submit"]').click();
    await eventually(async () => Object.values((await state()).agents).some(agent => agent.source === 'manual' && agent.chatId === 'chat:demo-research' && agent.result.includes('checked the launch checklist')), 'manual result edit persists');
  });

  await test('Copy actions pass the exact result and report text to the clipboard API', async () => {
    // Replace only this disposable test page's clipboard API; leave the user's OS clipboard untouched.
    await dashboard.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.compassTestClipboard = String(text); } } }));
    await dashboard.getByRole('button', { name: 'Copy result', exact: true }).click();
    assert.equal(await dashboard.evaluate(() => window.compassTestClipboard), 'Demo manual result: next steps are ready for review.\nRevision: checked the launch checklist.');
    await dashboard.locator('[data-page="overview"]').click();
    const reportText = await dashboard.locator('.report-card .report-text').first().innerText();
    await dashboard.locator('.report-card').first().getByRole('button', { name: /Copy update/ }).click();
    assert.equal(await dashboard.evaluate(() => window.compassTestClipboard), reportText);
    await dashboard.locator('#copy-day').click();
    assert.match(await dashboard.evaluate(() => window.compassTestClipboard), /Claude Compass.*\n.*active.*idle/s);
  });

  await test('Settings reject invalid values and export downloads complete local data', async () => {
    await dashboard.locator('[data-page="settings"]').click();
    const prior = (await state()).settings.idleSeconds;
    await dashboard.locator('#idle-seconds').fill('14');
    assert.equal(await dashboard.locator('#settings-form').evaluate(form => form.checkValidity()), false);
    await dashboard.locator('#settings-form [type="submit"]').click();
    assert.equal((await state()).settings.idleSeconds, prior);
    const invalid = await dashboard.evaluate(() => chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: { theme: 'invalid-theme' } }));
    assert.equal(invalid.ok, false);
    assert.match(invalid.error, /system.*light.*dark|theme/i);
    await dashboard.locator('#idle-seconds').fill('60');
    await dashboard.locator('#update-minutes').fill('0');
    await dashboard.locator('#settings-form [type="submit"]').click();
    await eventually(async () => (await state()).settings.updateMinutes === 0, 'disable automatic updates');
    const downloadPromise = dashboard.waitForEvent('download');
    await dashboard.locator('#export-data').click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /^claude-compass.*\.json$/);
    const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    assert.equal(exported.version, 1);
    assert.ok(exported.chats['chat:demo-launch']);
    assert.ok(exported.reports.length > 0);
    assert.ok(Object.values(exported.agents).some(agent => agent.name === 'Demo · Manual planning assistant'));
    assert.equal(exported.settings.updateMinutes, 0);
  });

  await test('Long titles and multiline composers fit desktop and 320/360 pixel layouts in both themes', async () => {
    const longTitle = 'Demo · ' + 'A very long conversation title for layout verification '.repeat(5);
    await page.evaluate(title => {
      const link = document.querySelector('nav a[href="/chat/demo-launch"]');
      link.title = title; link.textContent = title;
      document.querySelector('h1').textContent = title;
    }, longTitle);
    await page.bringToFront();
    await page.locator('[contenteditable]').fill('');
    const emptyShellHeight = await page.locator('[data-compass-composer]').evaluate(shell => shell.getBoundingClientRect().height);
    await page.locator('[contenteditable]').fill('Demo multiline composer.\nSecond line of editable text.\nThird line with a deliberately_long_unbroken_word_for_layout_testing.');
    assert.ok(await page.locator('[data-compass-composer]').evaluate(shell => shell.getBoundingClientRect().height) > emptyShellHeight, 'Full shell outline should grow with multiline text');
    await eventually(async () => (await state()).chats['chat:demo-launch'].title.startsWith('Demo · A very long'), 'long chat title captured');
    for (const theme of ['light', 'dark']) {
      await api(dashboard, { type: 'UPDATE_SETTINGS', settings: { theme } });
      await page.emulateMedia({ colorScheme: theme });
      await expectTheme(page, theme, '#compass-root');
      for (const width of [1440, 360, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await noHorizontalOverflow(page, `${theme} content at ${width}px`);
        const layout = await page.evaluate(() => {
          const editor = document.querySelector('[contenteditable]').getBoundingClientRect();
          const shell = document.querySelector('[data-compass-composer]').getBoundingClientRect();
          const controls = document.querySelector('[data-demo-send]').getBoundingClientRect();
          const label = document.querySelector('#compass-composer-label').getBoundingClientRect();
          const host = document.querySelector('#compass-root').getBoundingClientRect();
          return { editorBottom: editor.bottom, labelTop: label.top, labelRight: label.right, hostRight: host.right, width: innerWidth, shellTop: shell.top, shellLeft: shell.left, shellRight: shell.right, shellBottom: shell.bottom, controlsRight: controls.right, controlsBottom: controls.bottom, editorTop: editor.top, editorLeft: editor.left, editorRight: editor.right };
        });
        assert.ok(layout.labelTop >= layout.editorBottom && layout.labelRight <= layout.width, 'Composer label must fit below multiline input');
        assert.ok(layout.shellTop <= layout.editorTop && layout.shellLeft <= layout.editorLeft && layout.shellRight >= layout.editorRight && layout.shellBottom >= layout.editorBottom && layout.shellRight >= layout.controlsRight && layout.shellBottom >= layout.controlsBottom, 'Full composer outline must enclose multiline editor and controls');
        assert.ok(layout.hostRight <= layout.width, 'Floating identity card must remain onscreen');
        await dashboard.setViewportSize({ width, height: 900 });
        for (const view of ['overview', 'mailbox', 'settings']) {
          await dashboard.locator(`[data-page="${view}"]`).click();
          await noHorizontalOverflow(dashboard, `${theme} ${view} at ${width}px`);
        }
      }
    }
    await page.setViewportSize({ width: 1440, height: 1050 });
    await dashboard.setViewportSize({ width: 1440, height: 1050 });
    await page.evaluate(() => {
      const link = document.querySelector('nav a[href="/chat/demo-launch"]');
      link.removeAttribute('title'); link.textContent = 'Demo · Launch planning';
      document.querySelector('h1').textContent = 'Demo · Launch planning';
    });
    await page.locator('[contenteditable]').fill('');
  });

  await test('Returning from background resumes without crediting the away interval, and navigation changes the displayed clock', async () => {
    await page.bringToFront();
    await page.locator('[contenteditable]').click();
    await sleep(1200);
    await dashboard.bringToFront();
    await sleep(400);
    const frozen = total((await state()).chats['chat:demo-launch']);
    const clockBefore = await clockSnapshot(page);
    await sleep(2200);
    const clockAfter = await clockSnapshot(page);
    assert.equal(clockAfter.active, clockBefore.active);
    assert.equal(clockAfter.idle, clockBefore.idle);
    assert.equal(total((await state()).chats['chat:demo-launch']), frozen);
    await page.bringToFront();
    await page.locator('[contenteditable]').click();
    const returnSamples = await sampleClock(page, 3200);
    assertMonotonic(returnSamples, 'active');
    assert.ok(returnSamples.at(-1).active - returnSamples[0].active >= 1000);
    await page.locator('nav a[href="/chat/demo-research"]').click();
    await eventually(async () => (await page.locator('#compass-root .title').innerText()).includes('Research notes'), 'navigation updates identity title');
    await sleep(500);
    const researchClock = await clockSnapshot(page);
    const research = (await state()).chats['chat:demo-research'];
    assert.ok(clockMs(researchClock.active) + clockMs(researchClock.idle) <= total(research) + 2500, 'New chat must not inherit the old chat clock');
    await page.locator('nav a[href="/chat/demo-launch"]').click();
    await eventually(async () => (await page.locator('#compass-root .title').innerText()) === 'Demo · Launch planning', 'return navigation restores original identity');
    assert.match(await page.locator('#compass-composer-label').innerText(), /Demo · Launch planning/);
  });

  await test('Content Demo previews show the complete composer and identity card in both themes', async () => {
    await eventually(async () => (await page.locator('#compass-root .title').innerText()) === 'Demo · Launch planning', 'preview identity matches its displayed conversation');
    await page.evaluate(() => window.demoAgent('completed', 'Demo result: reviewed three source documents and recorded the next action.'));
    await page.locator('[contenteditable]').fill('');
    for (const theme of ['light', 'dark']) {
      await api(dashboard, { type: 'UPDATE_SETTINGS', settings: { theme } });
      await page.emulateMedia({ colorScheme: theme });
      await expectTheme(page, theme, '#compass-root');
      await page.screenshot({ path: path.join(previewDirectory, `claude-compass-chat-preview-${theme}.png`), fullPage: true });
      if (theme === 'light') await screenshot(page, 'claude-compass-chat-preview.png');
    }
  });

  await test('Reset while a chat is open clears the prior timer epoch and returns sensible empty states', async () => {
    await page.bringToFront();
    await api(dashboard, { type: 'RESET_DATA' });
    await eventually(async () => {
      const clock = await clockSnapshot(page);
      return clockMs(clock.active) + clockMs(clock.idle) <= 1000;
    }, 'reset clears live projection');
    const resetSamples = await sampleClock(page, 1800);
    assert.ok(resetSamples.every(sample => sample.active + sample.idle <= 3000), 'Old elapsed time must not reappear after reset');
    await page.close();
    await dashboard.bringToFront();
    await dashboard.locator('[data-page="settings"]').click();
    dashboard.once('dialog', dialog => dialog.accept());
    await dashboard.locator('#reset-data').click();
    await eventually(async () => Object.keys((await state()).chats).length === 0, 'confirmed reset clears persisted data');
    await dashboard.locator('[data-page="overview"]').click();
    assert.equal(await dashboard.locator('#empty-chats').isVisible(), true);
    await dashboard.locator('[data-page="mailbox"]').click();
    assert.equal(await dashboard.locator('#empty-agents').isVisible(), true);
    const saved = await state();
    assert.equal(Object.keys(saved.agents).length, 0);
    assert.equal(saved.reports.length, 0);
  });

  await test('Demo dashboard renders a labeled preview without changing saved user state', async () => {
    const saved = (await api(dashboard, { type: 'GET_STATE' })).state;
    const preview = await context.newPage();
    for (const theme of ['light', 'dark']) {
      await preview.goto(`chrome-extension://${extensionId}/dashboard.html?demo=1&theme=${theme}`);
      await preview.waitForLoadState('domcontentloaded');
      await expectTheme(preview, theme);
      assert.match(await preview.locator('#demo-banner').innerText(), /preview mode.*sample data/i);
      assert.deepEqual(await state(), saved);
      await screenshot(preview, `claude-compass-preview-${theme}.png`);
      if (theme === 'light') {
        const previewPath = process.env.COMPASS_PREVIEW_PATH || path.join(previewDirectory, 'claude-compass-preview.png');
        await preview.screenshot({ path: previewPath, fullPage: true });
      }
      await preview.locator('[data-page="mailbox"]').click();
      await screenshot(preview, `claude-compass-mailbox-preview-${theme}.png`);
      if (theme === 'light') await screenshot(preview, 'claude-compass-mailbox-preview.png');
    }
    await preview.close();
  });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: results.length, tests: results, scriptErrors: errors }, null, 2));
}

run().catch(async error => {
  console.error(error.stack || error);
  if (worker) console.error('Message diagnostics:', JSON.stringify(await worker.evaluate(() => globalThis.compassTestMessages)));
  if (context) for (const page of context.pages()) console.error('Page diagnostics:', await page.evaluate(() => ({ url: location.href, visible: document.visibilityState, focused: document.hasFocus(), notice: document.querySelector('#compass-root')?.shadowRoot?.querySelector('.notice')?.textContent, title: document.querySelector('#compass-root')?.shadowRoot?.querySelector('.title')?.textContent })));
  process.exitCode = 1;
}).finally(async () => {
  if (context) await context.close();
  fs.rmSync(profilePath, { recursive: true, force: true });
});
