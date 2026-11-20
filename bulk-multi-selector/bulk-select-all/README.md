# Bulk Select All

A Manifest V3 extension for Microsoft Edge / Chrome that **checks every checkbox on a page in one click** — built for image/file download lists where clicking row by row is painful.

## Features

- **Select + scroll to bottom** — checks rows while scrolling to the end, waits for lazily loaded / infinite-scroll content, then keeps going. Live progress (`Selected 24 · scrolled 67%`).
- **Select all / Select visible / Invert / Unselect** in one click.
- **Uses the page's own "Select all" header box first** (when present) and verifies it really selected rows; otherwise it clicks each checkbox.
- **Auto-scroll for long and virtualized lists** — re-detects the scroll container if the list re-renders.
- Works inside **iframes** (content script runs in every frame).
- **React / Vue / Angular friendly** — real click + mouse events, fallbacks for custom components (`role="checkbox"`, `aria-checked`, `data-state`).
- **Draggable floating panel** (Shadow DOM, page CSS cannot break it), remembers position, collapsible.
- **Auto-select on page load**, per domain.
- Keyboard shortcut **Alt + Shift + A**.

## Install (Load unpacked)

1. Open `edge://extensions/` (or `chrome://extensions/`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
4. Pin the extension to the toolbar.
5. **Reload (F5) the tabs that were already open** — content scripts only run on pages loaded after install.

> After editing the code: click **Reload** on the extension card, then F5 the page.

## Usage

1. Open the page with the list (each row has a checkbox).
2. On the floating panel (bottom-right) click **Select + scroll to bottom** — or open the popup / press `Alt + Shift + A`.
3. Wait for the progress to finish, then use the page's Download button.

| Button | What it does |
| --- | --- |
| Select + scroll to bottom | Selects while scrolling to the end; no scroll restore, longer lazy-load wait |
| Select all | Selects everything, scrolling according to settings |
| Select visible | Selects only checkboxes currently rendered |
| Invert | Flips the state of every checkbox found |
| Unselect all | Unchecks everything |

## Settings (popup → Advanced settings)

| Option | Meaning |
| --- | --- |
| Delay between clicks (ms) | Pause between two checkbox clicks; raise it if the page drops clicks. |
| Wait per scroll step (ms) | Time for the page to render after each scroll step (500–800 ms on slow pages). |
| Idle rounds at bottom | Extra checks after reaching the bottom (waits for lazy loading). Default 4; "Select + scroll to bottom" uses at least 6. |
| Prefer the page's own “Select all” box | Click the header select-all first (much faster on big lists). |
| Auto-scroll while selecting | Enable/disable automatic scrolling. |
| Restore scroll position when done | Scroll back to where you started after finishing. |
| Auto-select on page load | Run "select all" every time a page from that domain opens. |

## How it works

- `content.js` runs at `document_idle` in every frame. The panel is only mounted in the top frame; other frames report to it via `window.postMessage({ source: 'BSA' })`.
- Checkbox detection: `input[type="checkbox"]`, `[role="checkbox"]`, `[aria-checked]`, `[data-state]` — radios/tabs/options are excluded.
- Select-all detection: `aria-label` / `label` / header text (`Select`, `Select all`, `Chọn`, `Chọn tất cả`, …) plus a header-container heuristic, then verified by comparing checked counts before/after.
- Scrolling: picks the deepest scrollable element **containing checkboxes** (falls back to the largest scrollable element, then the page), steps by ~85% of its height, re-detects the element when a virtualized list re-renders, nudges up/down at the bottom to trigger lazy loading, and stops after `idleRounds` rounds without new content (or `maxSteps` / `maxDuration`).

## Project structure

```text
manifest.json        MV3 manifest
background.js        service worker: defaults, shortcut, command relay
content.js           detection, clicking, auto-scroll, floating panel (Shadow DOM)
popup.html/.css/.js  toolbar popup: actions + settings
welcome.html         quick start page opened on install
icons/               extension icons (16/32/48/128)
tools/               test harnesses and helper scripts
```

## Testing

Self-contained harnesses (stub `chrome.*`, no extension install needed). Run them from the repository root:

```powershell
$repo = (Get-Location).Path -replace '\\', '/'
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' --headless=new --disable-gpu `
  --allow-file-access-from-files --virtual-time-budget=60000 --dump-dom `
  "file:///$repo/extensions/bulk-select-all/tools/test-harness.html"
```

Other harnesses:

| File | Checks |
| --- | --- |
| `tools/test-harness.html` | 60 rows in a scroll container → select all + auto-scroll |
| `tools/test-harness-scroll.html` | Lazy loading: 40 → 100 rows, "select + scroll to bottom" |
| `tools/test-harness-header.html` | "Select all" header: select / clear / invert |
| `tools/syntax-check.html` | Syntax of content.js, background.js, popup.js, manifest.json |

End-to-end against a real browser (loads the extension unpacked over CDP, clicks the panel button, reads checkbox state):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\extensions\bulk-select-all\tools\cdp-test.ps1 -Headed -Browser edge
```

Last run on this machine: 60/60 rows, 100/100 lazy-loaded rows, header select/clear/invert all pass, E2E panel injection + select + unselect pass.

## Troubleshooting

- **Nothing happens** — the page was opened before installing the extension. Open the popup and click **Reload page** (or press F5).
- **No checkboxes found** — the page uses image/div fake checkboxes without `role="checkbox"`/`aria-checked`; inspect the element and open an issue with its markup.
- **Only a few rows selected** — raise *Wait per scroll step* to 600–900 ms and *Idle rounds at bottom* to 6–8.
- **Browser pages** (`edge://`, `chrome://`, add-on stores) cannot be injected — browser limitation.
