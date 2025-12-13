# Glazyr Chrome Extension

Vision-first AI assistant for web browsing (Chrome Extension, Manifest V3).

## Architecture

![Glazyr architecture](./Screenshot%202025-12-12%20230448.png)

At a high level:

- **Content scripts** capture page context + execute actions.
- **Service worker (background)** enforces safety policy, handles capture/vision flows, and talks to the runtime backend.
- **Runtime backend (AWS)** returns the next action to execute.

## Install (Load Unpacked)

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked**
4. Select the `dist/` folder

## What’s in this repo

- **`dist/`**: the packaged extension Chrome loads (service worker, content scripts, popup, manifest, icons).
- **`tools/`**: helper scripts (icon resizing, packaging).

## Permissions

This extension requests:

- **`<all_urls>` host permission**: so content scripts can run on pages you visit.
- **`activeTab`, `scripting`**: to interact with the current page when you invoke the extension.
- **`storage`**: to persist settings/state.
- **`tabs`, `webNavigation`**: to read basic tab/navigation context needed for the browsing assistant.

See `dist/manifest.json` for the authoritative list.

## Safety enforcement (important)

Safety config is loaded from `chrome.storage.local` (written by the control plane) and enforced in multiple places:

- **Kill switch** blocks capture + action execution.
- **Agent mode**:
  - `observe` blocks click/type/navigate/submit
- **Allowed domains + disallowed actions** gate capture + actions.

The extension also reports enforcement signals back to the control plane in its status heartbeat.

## Runtime backend integration (AWS)

The background worker can send queries to an external runtime backend and then poll for next actions:

- `POST /runtime/task/start`
- `GET /runtime/next-action?deviceId=...`
- `POST /runtime/action-result`

This is implemented in `dist/background.js` (poll loop + action result reporting).

### Runtime configuration keys

The runtime endpoint/auth can be configured via `chrome.storage.local`:

- `glazyrRuntimeBaseUrl`: Function URL base (no trailing slash)
- `glazyrRuntimeApiKey`: optional API key (sent as `x-glazyr-api-key`)
- `glazyrDeviceId`: generated automatically if missing

> The current build also has a default Function URL baked into `dist/background.js`.

## Image handling features

- **Framed screenshot (crop capture) + OCR (working POC)**: capture a selected region and run Google Vision OCR via the AWS runtime (`POST /runtime/vision/ocr`).
- **Drag-and-drop analysis**: drag an image file or an image element onto the page to send it to the background (currently still a stub/mock beyond OCR).

### Widget UX (current POC)

- OCR prints into the **chat** (assistant message), not a dedicated OCR panel.
- The widget does **not** render the screenshot image (it’s already visible on the page).
- A draggable **in-page Glazyr logo launcher** toggles the widget.

## How to take a “framed screenshot” (crop capture)

1. Open any webpage.
2. Click the in-page **Glazyr logo launcher** to open the widget (or click the extension icon).
3. Click **Framed shot**.
4. Select an area, release to capture.

Alternative (via text query in the popup): type **“framed screenshot”** (or **“crop capture”**) and submit.

## Runtime requirements for OCR

- Provision the AWS runtime: see `../runtime-aws/README.md`
- Enable **billing** on the GCP project and enable the **Cloud Vision API**

## Update the extension logo (icons)

Source image:

- `Mechanical eye with blue iris.png`

Generate required icon sizes (16/48/128):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/resize-icons.ps1
```

This overwrites:

- `dist/icons/icon16.png`
- `dist/icons/icon48.png`
- `dist/icons/icon128.png`

## Package a ZIP for GitHub Releases / sharing

Create a versioned ZIP (uses version in `dist/manifest.json`):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/package-extension.ps1
```

Output:

- `release/glazyr-chrome-extension-v<version>.zip`
