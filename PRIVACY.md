# Privacy Policy

**Last updated:** December 13, 2025

## Overview

Glazyr Chrome Extension ("we", "our", or "the extension") is a vision-first AI assistant for web browsing. This privacy policy explains how we handle data when you use the extension.

## Data Collection and Usage

### Local Storage

The extension stores the following data **locally on your device** using Chrome's `chrome.storage.local` API:

- **Runtime configuration**: MCP runtime URL and API keys (if configured)
- **Device ID**: A randomly generated unique identifier for your installation
- **Page context buffer**: Recent page URLs, titles, and text excerpts (last 5 pages, stored locally)
- **Last capture**: Screenshot data and OCR/vision analysis results (stored locally)
- **Widget state**: Widget position and size preferences
- **Safety policy**: Agent mode settings, kill switch state, allowed domains (from control plane)

**This data never leaves your device** unless you explicitly interact with external runtimes.

### Data Sent to External Services

When you use natural language queries or explicitly invoke the MCP runtime:

1. **LangChain MCP Runtime** (if configured):
   - **What we send**: Page context (URL, title, text excerpt), OCR/vision-derived text, your query
   - **What we don't send**: Raw screenshots, full page content, personal data
   - **Purpose**: AI agent orchestration and query processing
   - **Data retention**: Governed by the MCP runtime's privacy policy

2. **Vision Runtime (AWS)** (for OCR/vision analysis):
   - **What we send**: Screenshot images (only when you explicitly capture)
   - **Purpose**: OCR text extraction and image analysis
   - **Data retention**: Governed by the Vision runtime's privacy policy

### Page Context Capture

The extension captures page context (URL, title, visible text) from pages you visit to provide AI assistance. This data is:

- Stored **locally** in a buffer (last 5 pages)
- Only sent to external runtimes when you explicitly ask a question
- Never sent automatically or in the background
- Cleared when you reload the extension or clear browser data

### Screenshots

Screenshots are only captured when you:

- Click "Framed shot" and select a region
- Click "Full page" for a full-page capture
- Drag and drop an image onto the page

Screenshots are:

- Processed locally or sent to the Vision runtime for OCR/analysis
- Stored locally in `chrome.storage.local`
- Not sent to any service unless you explicitly capture them

## Permissions

The extension requests the following permissions:

- **`<all_urls>`**: To inject content scripts and capture page context on pages you visit
- **`activeTab`, `scripting`**: To interact with the current page when you invoke actions
- **`storage`**: To persist settings and state locally
- **`tabs`, `webNavigation`**: To read basic tab/navigation context
- **`offscreen`**: For audio transcription features (if used)

These permissions are used **only** for the extension's functionality and are not used to track you across websites.

## Third-Party Services

### LangChain Agents MCP Server

- **Service**: LangChain agents MCP runtime (default: `https://langchain-agent-mcp-server-554655392699.us-central1.run.app`)
- **Data shared**: Page context, queries, derived text
- **Purpose**: AI agent orchestration
- **Privacy**: Governed by the MCP runtime provider's privacy policy

### Vision Runtime (AWS)

- **Service**: AWS Lambda-based vision/OCR service
- **Data shared**: Screenshot images (only when explicitly captured)
- **Purpose**: OCR text extraction and image analysis
- **Privacy**: Governed by the Vision runtime provider's privacy policy

## Data Security

- All data is stored locally using Chrome's secure storage APIs
- API keys and sensitive configuration are stored in `chrome.storage.local` (encrypted by Chrome)
- Communication with external runtimes uses HTTPS
- No data is transmitted without your explicit action (asking a question or capturing a screenshot)

## Your Rights

You have the right to:

- **Inspect stored data**: Use Chrome DevTools → Application → Storage → Local Storage to view extension data
- **Clear data**: Uninstall the extension or clear browser data to remove all stored information
- **Configure runtimes**: Set your own MCP runtime URL or disable external services
- **Control captures**: Only capture screenshots when you explicitly choose to

## Children's Privacy

This extension is not intended for users under the age of 13. We do not knowingly collect data from children.

## Changes to This Policy

We may update this privacy policy from time to time. The "Last updated" date at the top indicates when changes were made.

## Contact

For privacy-related questions, contact us at: **greetings@automationalien.com**

You can also reach out via GitHub issues or your preferred channel.

## Compliance

This extension complies with:
- Chrome Web Store Developer Program Policies
- General data protection principles (local-first, explicit consent, minimal data collection)
