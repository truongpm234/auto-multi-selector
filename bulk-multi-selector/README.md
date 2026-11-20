# Browser Extensions

A small collection of Manifest V3 extensions for Microsoft Edge / Chrome. Each extension lives in its own folder under [`extensions/`](extensions) and is self-contained (own `manifest.json`, icons, docs and tests).

| Extension | What it does |
| --- | --- |
| [`bulk-select-all`](extensions/bulk-select-all) | Checks every checkbox on a page (image/file download lists) in one click. Auto-scrolls long and lazily loaded lists to the bottom while selecting. |

## Install an extension (Load unpacked)

1. Open `edge://extensions/` (or `chrome://extensions/`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and pick the extension folder, e.g. `extensions/bulk-select-all` — the folder that contains `manifest.json`.
4. Pin it to the toolbar. Reload (F5) tabs that were open before installing.

> After pulling new code: click **Reload** on the extension card, then F5 the page.

## Adding a new extension

1. Create `extensions/<name>/` and put its `manifest.json`, scripts, icons and `README.md` there.
2. Keep it self-contained — no shared files between extensions (each folder must be loadable as-is).
3. Add a row to the table above with a short description and a link.
4. Commit and push:

```bash
git add extensions/<name> README.md
git commit -m "feat(<name>): initial version"
git push
```

## Repository layout

```text
README.md                     this file
extensions/
  bulk-select-all/            one extension = one folder
    manifest.json
    background.js
    content.js
    popup.html / popup.css / popup.js
    welcome.html
    icons/
    tools/                    test harnesses + helper scripts
    README.md                 extension-specific documentation
```

## Development notes

- Everything is plain HTML/CSS/JS (no build step, no dependencies).
- Test harnesses run without installing the extension — see each extension's README.
- Build artifacts (`*.zip`), logs and test output files are ignored by git.
