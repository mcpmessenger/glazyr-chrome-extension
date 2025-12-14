# Glazyr Chrome Extension Team: Backend Integration Strategy (Vision + MCP Runtime)

**Project Manager:** Manus AI
**Date:** December 13, 2025
**Goal:** Ensure the Chrome Extension efficiently captures visual context and communicates with:

- the **Vision runtime** (OCR/vision analysis), and
- the **MCP runtime** (agent orchestration + monitoring)

…while keeping the browser UI separated from raw data exposure.

---

## 1. Extension’s role (separation of concerns)

The core responsibility of the Chrome Extension remains the same: **context capture and local safety enforcement**.

- **Vision/OCR**: performed by the Vision runtime (service endpoint). The extension may send images to this service for OCR/vision analysis.
- **Agent orchestration (MCP)**: performed by the MCP runtime (`glazyr-control`). The extension sends **derived text context** (page excerpt, OCR/caption/labels text) rather than raw screenshots by default.

The extension must ensure that the captured visual data is:
1.  **High-fidelity:** Capture the most relevant visual context (full screenshot, selected region, or dropped image).
2.  **Efficiently Formatted:** Convert the image data into a format that is easily transmittable over HTTP and consumable by the Node.js backend.
3.  **Securely Transmitted:** Send the data to the correct Glazyr API endpoint.

## 2. Data flow and API contracts

The extension interacts with two backends:

### 2.1 Vision runtime (OCR/vision)

The Vision runtime receives screenshot data for OCR/vision analysis (PNG/JPEG base64 data URLs or equivalent) and returns derived text (OCR/caption/labels/objects).

### 2.2 MCP runtime (agent orchestration + monitoring)

The MCP runtime uses MCP endpoints:

- `GET /mcp/manifest`
- `POST /mcp/invoke`

Minimal invoke body:

```json
{
  "tool": "agent_executor",
  "inputs": {
    "input": "<user message + derived context>",
    "task_id": "<uuid>"
  }
}
```

Monitoring (recommended):

- `GET /api/tasks?limit=25`
- `GET /api/tasks/{task_id}`

### 2.3. What the extension should send to MCP (default)

To keep the MCP runtime “text-first” and reduce sensitive payload exposure:

- **User query**
- **URL + title**
- **Small page excerpt** (truncated)
- **Derived vision text** (OCR/caption/labels summary), truncated

Do **not** send raw screenshots to MCP unless explicitly required by a workflow.

### 2.4. Website “control plane” integration (optional)

If routing through the website server (recommended for centralized config + CORS simplification), use proxy routes:

- `GET /api/runtime/mcp/manifest` → `{RUNTIME}/mcp/manifest`
- `POST /api/runtime/mcp/invoke` → `{RUNTIME}/mcp/invoke`
- `GET /api/runtime/tasks?limit=` → `{RUNTIME}/api/tasks`
- `GET /api/runtime/tasks/[taskId]` → `{RUNTIME}/api/tasks/{task_id}`

## 3. Action Items for Extension Team

The following updates are required to ensure compatibility with the new backend logic:

| Priority | Component | Action | Rationale |
| :--- | :--- | :--- | :--- |
| **High** | **MCP Invoke** (`background.js`) | **Send agent calls to MCP runtime:** `POST /mcp/invoke` with `tool=agent_executor` and `inputs.task_id` (UUID). | Enables robust orchestration + resumable workflows. |
| **High** | **Monitoring** (widget UI) | **Poll `GET /api/tasks/{task_id}`** to show status updates without exposing raw data. | Gives users visibility while keeping UI safe. |
| **High** | **Vision capture** (`background.js`, content scripts) | **Keep screenshot handling in Vision runtime only** and pass derived text into MCP. | Separation-of-concerns + safety. |
| **Medium** | **Auth + limits** | **Attach API key header if configured** and keep payloads within size limits. | Prevents 403/413 failures and abuse. |
| **Low** | **UX** | **Show concise quotes/summaries** instead of verbose OCR blobs. | Better user-facing experience; full data remains for AI. |

By keeping Vision (images) separate from MCP (derived text + orchestration), the extension remains vision-first while staying microservice-friendly and safer-by-default.
