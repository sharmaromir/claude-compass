#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const AxeBuilder = require('@axe-core/playwright').default;

const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-accessibility-'));
const fixture = fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8');
const failures = [];
let checks = 0;
let context;

async function audit(page, label, include) {
  await page.bringToFront();
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
  if (include) builder = builder.include(include);
  const result = await builder.analyze();
  checks++;
  if (result.violations.length) {
    const summary = result.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help,
      nodes: v.nodes.map(n => ({ target: n.target, message: n.failureSummary })) }));
    failures.push({ label, violations: summary });
    console.error(`FAIL ${label}: ${JSON.stringify(summary, null, 2)}`);
    const dir = path.join(root, 'test-results');
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `${label}.png`), fullPage: true });
  } else console.log(`PASS accessibility: ${label}`);
}

async function run() {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: { width: 1440, height: 1000 },
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  await context.route(/^https?:\/\//, route => route.fulfill({ status: 200, contentType: 'text/html', body: fixture }));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  const chat = await context.newPage();
  await chat.goto('https://claude.ai/chat/demo-accessibility');
  await chat.locator('#compass-root .panel').waitFor();
  const demo = await context.newPage();

  for (const theme of ['light', 'dark']) {
    await demo.emulateMedia({ colorScheme: theme });
    await demo.goto(`chrome-extension://${id}/dashboard.html?demo=1`);
    await demo.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme);
    for (const width of [1440, 360]) {
      await demo.setViewportSize({ width, height: 1000 });
      for (const view of ['overview', 'mailbox', 'settings']) {
        await demo.locator(`[data-page="${view}"]`).click();
        await audit(demo, `${theme}-${width}-${view}`);
      }
    }
    await demo.setViewportSize({ width: 1000, height: 900 });
    await demo.locator('[data-page="mailbox"]').click();
    await demo.locator('#add-agent').click();
    await audit(demo, `${theme}-agent-dialog`);
    await demo.locator('#cancel-agent').click();
    const response = await popup.evaluate(theme => chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: { theme } }), theme);
    assert.equal(response.ok, true, response.error);
    await popup.reload();
    await popup.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    await audit(popup, `${theme}-popup`);
    await chat.waitForFunction(theme => document.querySelector('#compass-root')?.dataset.theme === theme, theme);
    await audit(chat, `${theme}-chat-panel`, '#compass-root');
  }
  assert.equal(failures.length, 0, `${failures.length}/${checks} accessibility scans failed. See details above.`);
  console.log(`Accessibility: ${checks}/${checks} scans passed (WCAG A/AA, light + dark, desktop + mobile).`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
  if (context) await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
});
