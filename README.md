# Claude Compass

[![Test extension](https://github.com/sharmaromir/claude-compass/actions/workflows/test.yml/badge.svg)](https://github.com/sharmaromir/claude-compass/actions/workflows/test.yml)

A local Chrome extension for recognizing Claude chats by color, seeing where your time goes, and keeping agent results in a session mailbox. Built for `https://claude.ai` with Manifest V3. No build step, account, server, or API key.

[Download the latest release](https://github.com/sharmaromir/claude-compass/releases/latest) · [Report a problem](https://github.com/sharmaromir/claude-compass/issues)

![Claude Compass dark overview with sample conversations](https://raw.githubusercontent.com/sharmaromir/claude-compass/main/docs/images/overview-dark.png)

[See the light theme](https://github.com/sharmaromir/claude-compass/blob/main/docs/images/overview-light.png). Screenshots use sample data.

## Install

1. Download and extract the extension ZIP from [Releases](https://github.com/sharmaromir/claude-compass/releases/latest), or clone this repository. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the extracted or cloned folder containing `manifest.json`.
4. Reload your open Claude tabs. Pin **Claude Compass** from Chrome's Extensions menu if desired.

After a code change, click the extension's reload button in `chrome://extensions`, then reload Claude. The extension cannot run inside Claude's desktop application or other extensions' side panels.

Keep the loaded folder in place: Chrome runs the unpacked extension from that location. Updating the files and reloading the same installed extension preserves its local data.

## Use

- **Chat identity:** a stable automatic color follows each saved `/chat/<id>` or `/code/<id>` session. The composer outline and “Sending to” label identify the current destination; sidebar accents help recognize other chats. Choose a custom color from the small Compass panel or dashboard. The palette has eight colors, so automatic colors can repeat. New, unsaved chats use a neutral cue until Claude assigns a session URL.
- **Dark mode:** in **Settings → Appearance**, choose **System**, **Light**, or **Dark**, then save. The preference applies to the chat panel, dashboard, and popup. System follows your operating system's color preference; Compass does not change Claude's own theme.
- **Activity:** the panel shows today's active and idle time. Time is tracked only in a visible, focused Claude chat. After 60 seconds without interaction, time becomes idle; change the threshold in Settings. Inactive tabs do not accumulate time. Reading without interacting eventually counts as idle: this is an interaction estimate, not a measure of productive thinking. Only one chat owns the timer, even across windows.
- **Updates:** the dashboard saves a report every 15 tracked minutes by default, and can create one on demand. Set the interval to 0 to turn automatic updates off. Copy a summary and paste it wherever you want. Reports stay in the extension; nothing is posted to Claude or sent elsewhere.
- **Mailbox:** filter agents by session and status, read their available results, mark items read, or add and maintain manual entries for a tracked chat. Observed and manual entries are labeled separately. Running means **last observed running**, not a guaranteed live server state.
- **Your data:** the dashboard can export JSON, delete a chat's local records, or clear all extension data. Pausing stops time tracking; color cues and the mailbox remain available.

## Mailbox support boundary

The observer is experimental and conservative. It recognizes structured agent cards that have an explicit stable agent/tool ID and explicit status/result metadata, as defined in `adapter.js`. It never scans ordinary assistant prose for phrases such as “agent running.” An agent card disappearing does not mean that the agent completed, and collapsing a card does not erase a previously captured result.

Claude does not provide this extension with a documented browser subagent event API. The built-in selectors are verified against representative fixtures; automatic collection against Claude's current agent UI still requires live validation. Standard Claude chats may expose no agent cards. Hidden, virtualized, unopened, and server-side subagents cannot be discovered by this DOM observer. Closing a session tab stops observation. For those cases, the working manual mailbox can store a status and pasted result; guaranteed automatic tracking would require an explicit Claude Code hook/API integration.

## Timing and persistence

Colors, titles, canonical chat URLs, timing totals, daily totals, saved reports, and mailbox entries are stored in `chrome.storage.local`. Live timing checkpoints use `chrome.storage.session`. There are no network requests, analytics, remote libraries, or cloud sync. Ordinary conversation content and typed messages are not recorded; exposed agent result text is saved to support the mailbox.

The chat panel displays hours, minutes, and seconds, advancing every second. Between five-second saves, it projects only the current foreground interval from an authoritative timing checkpoint. The same calculation splits active/idle time and local midnight, avoiding double-counting when saved totals arrive. Pausing, leaving the chat, or changing sessions stops that projection. Gaps longer than 15 seconds (for example, sleep or a suspended tab) are dropped. Closing the browser, crashes, or a suspended page may lose the last sample. Daily totals use your computer's local timezone. Changing timezone can alter how subsequent samples are grouped. Screen lock while the page remains focused can count as idle until the browser sleeps. Tracking starts after installation and does not reconstruct past usage.

Chrome grants this extension storage permission and content-script access only on `https://claude.ai/*`. It does not request browsing history, cookies, notifications, or broad access to other websites. Incognito access is not enabled by default. This is an independent personal extension, not an Anthropic product.

## Develop and test

Runtime files are plain JavaScript, HTML, and CSS; installing dependencies is unnecessary for normal use. For development, clone this repository and run the commands below from its root. Tests require Node 22.12 or newer; packaging also requires Python 3:

```sh
npm ci
npx playwright install chromium
npm run test:all
npm run package
```

`npm test` runs pure timing, storage, sender validation, and migration tests. `npm run test:browser` exercises the installed extension in isolated Chromium. `npm run test:accessibility` checks WCAG A/AA rules in both themes, including mobile layouts, dialogs, popup, and the chat panel. `npm run package` creates a ZIP in `dist/` from an explicit allowlist, excluding development dependencies, tests, Git metadata, and local test data. The GitHub Actions workflow repeats the complete suite on Linux and uploads the installable ZIP when it passes.

The browser tests launch isolated Chromium with the extension, intercept web requests with clearly labeled demo pages, and leave your normal Chrome profile unchanged. They verify color persistence, navigation, timing, conservative agent detection, reports, dashboard, and popup. They do not claim live Claude compatibility. Test screenshots are written beside the extension folder by default; set `COMPASS_PREVIEW_DIR` to change the destination for all screenshots (or `COMPASS_PREVIEW_PATH` for the primary dashboard image).

Version 0.2.0 passes 29 core tests, 21 end-to-end browser scenarios, and 18 automated accessibility scans. The updated dark dashboard, popup, chat panel, saved appearance preference, and timer resume were also checked in signed-in Chrome.

The installed extension was checked on a signed-in Claude session on October 16, 2026: sidebar colors, composer outline and destination label, switching between saved chats, separate activity totals, dashboard launch, and saving a local report all worked. The live check caught and fixed an overlap with Claude's absolutely positioned composer placeholder; the browser fixture now tests that layout too. Automatic agent discovery has only been tested with fixtures, because the live chats inspected did not expose agent cards.

Open `dashboard.html?demo=1` in a browser to see the labeled demo without installing the extension. Demo data is never written into real extension storage.

Main files:

| File | Role |
| --- | --- |
| `manifest.json` | Chrome permissions and entry points |
| `common.js` | Identity, duration formatting, pure timing calculations |
| `background.js` | Serialized storage, timer ownership, reports, mailbox |
| `adapter.js` | Claude URL, composer, title, agent DOM selectors |
| `content.js`, `content.css` | Chat color cues, local panel, activity sampling |
| `dashboard.*`, `popup.*` | Reports, settings, mailbox, launcher |
| `tests/` | Core tests and isolated-browser fixtures |

If Claude changes its markup, update `adapter.js` and add a matching fixture test. Avoid broad text-based agent detection, because it can silently report fictional activity from chat messages.

Reference documentation: [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts), [Chrome storage](https://developer.chrome.com/docs/extensions/reference/api/storage), and [Claude Code subagents](https://code.claude.com/docs/en/sub-agents).
