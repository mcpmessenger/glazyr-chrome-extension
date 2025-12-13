# Glazyr Chrome Extension

Vision-first AI assistant for web browsing (Chrome Extension, Manifest V3).

## Install (Load Unpacked)

1. Clone this repo.
2. Open `chrome://extensions/`
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked**.
5. Select the `dist/` folder from this repo.

## What’s in this repo

- **`dist/`**: the packaged extension Chrome loads (service worker, content scripts, popup, manifest, icons).
- **`tools/`**: small helper scripts (ex: regenerate icons).

## Permissions

This extension requests:
- **`<all_urls>` host permission**: so content scripts can run on pages you visit.
- **`activeTab`, `scripting`**: to interact with the current page when you invoke the extension.
- **`storage`**: to persist settings/state.
- **`tabs`, `webNavigation`**: to read basic tab/navigation context needed for the browsing assistant.

See `dist/manifest.json` for the authoritative list.

## Image handling features

- **Drag-and-drop analysis**: drag an image file or an image element onto the page to send it to the background for (mock) analysis.
- **Crop capture (mock)**: trigger via a query (e.g. “Start crop capture”).

> Note: crop capture UI + real image processing are mocked in this proof-of-concept.

## Update the extension logo (icons)

Source image:
- `Mechanical eye with blue iris.png` (repo root)  
  - The script also supports `dist/Mechanical eye with blue iris.png` if you keep assets inside `dist/`.

Generate the required Chrome icon sizes (16/48/128):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/resize-icons.ps1
```

This overwrites:
- `dist/icons/icon16.png`
- `dist/icons/icon48.png`
- `dist/icons/icon128.png`

## Package a ZIP for GitHub Releases / sharing

Create a versioned ZIP (uses the version in `dist/manifest.json`):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/package-extension.ps1
```

Output:
- `release/glazyr-chrome-extension-v<version>.zip`

## First-time GitHub setup (this repo)

The target repo is: [`mcpmessenger/glazyr-chrome-extension`](https://github.com/mcpmessenger/glazyr-chrome-extension)

From this folder:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin git@github.com:mcpmessenger/glazyr-chrome-extension.git
git push -u origin main
```

To publish a GitHub Release ZIP via CI, push a tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```
