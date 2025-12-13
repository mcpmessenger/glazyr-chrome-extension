# Glazyr Chrome Extension Team: Backend Integration Strategy for Vision Processing

**Project Manager:** Manus AI
**Date:** December 13, 2025
**Goal:** Ensure the Chrome Extension efficiently captures visual context and communicates with the new Google Vision-powered Glazyr backend for a functional, vision-first AI assistant.

---

## 1. Extension's Role in Vision Processing

The core responsibility of the Chrome Extension remains the same: **context capture and secure transmission**. The actual Google Vision API calls will be handled by the Glazyr Next.js backend (FE Team's responsibility).

The extension must ensure that the captured visual data is:
1.  **High-fidelity:** Capture the most relevant visual context (full screenshot, selected region, or dropped image).
2.  **Efficiently Formatted:** Convert the image data into a format that is easily transmittable over HTTP and consumable by the Node.js backend.
3.  **Securely Transmitted:** Send the data to the correct Glazyr API endpoint.

## 2. Data Flow and API Contract

The extension's primary interaction is with the Glazyr web application's task API. Based on the analysis of the FE repository, the endpoint is likely `/api/tasks`.

### 2.1. Required Data Format

The extension must package the user's query and the visual context into a single JSON payload for the backend.

| Field | Type | Description | Source |
| :--- | :--- | :--- | :--- |
| `query` | `string` | The user's natural language question (e.g., "whats on this page?"). | User Input |
| `screenshot_data` | `string` | The captured image data, **MUST be a Base64 encoded string** of the image (e.g., JPEG or PNG). | Content/Background Script |
| `url` | `string` | The URL of the page where the capture occurred. | `chrome.tabs` API |
| `capture_type` | `string` | The method of capture (e.g., `"full_page"`, `"region_select"`, `"drag_drop"`). | Extension Logic |

### 2.2. API Endpoint

The extension should continue to use the established API endpoint for task execution.

| Detail | Value |
| :--- | :--- |
| **Method** | `POST` |
| **Endpoint** | `[GLAZYR_BASE_URL]/api/tasks` |
| **Content-Type** | `application/json` |

## 3. Action Items for Extension Team

The following updates are required to ensure compatibility with the new backend logic:

| Priority | Component | Action | Rationale |
| :--- | :--- | :--- | :--- |
| **High** | **Image Capture Logic** (`content.js`, `background.js`) | **Standardize Base64 Encoding:** Ensure all image capture methods (full screen, region select, drag/drop) consistently encode the image data as a clean, URL-safe Base64 string before transmission. | The backend will decode this string to a `Buffer` for the Google Vision API. |
| **Medium** | **API Bridge** (`background.js` or equivalent) | **Review Payload Structure:** Verify that the JSON payload sent to `/api/tasks` strictly adheres to the contract defined in Section 2.1. | Any deviation will break the new vision processing logic on the backend. |
| **Low** | **Error Handling** | **Improve User Feedback:** Enhance error handling for API calls. If the backend returns a 5xx error, provide a clear, user-friendly message indicating a server-side vision processing failure. | Better user experience during initial rollout and debugging. |

By focusing on reliable context capture and adherence to the API contract, the extension team will successfully enable the new Google Vision capabilities without needing to implement the Google SDK directly.
