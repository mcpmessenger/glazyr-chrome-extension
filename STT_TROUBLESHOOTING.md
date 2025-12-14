# STT (Speech-to-Text) Troubleshooting Guide

This guide helps troubleshoot issues with the Whisper STT (Speech-to-Text) feature in the Glazyr Chrome Extension.

## Overview

The STT feature uses:
- **OpenAI Whisper API** for transcription
- **Offscreen document** for audio recording (to avoid site Permissions-Policy restrictions)
- **Chrome microphone permissions** for audio access

## Common Issues and Solutions

### 1. Microphone Permission Denied

**Symptoms:**
- Error message: "Microphone permission was dismissed/denied"
- Mic button doesn't start recording
- Status shows "Mic permission denied or unavailable"

**Solutions:**

1. **Grant permission when prompted:**
   - Click the mic button (🎙) in the widget
   - When Chrome prompts, click **Allow**

2. **Use the mic setup page:**
   - If Chrome won't prompt anymore, open the Glazyr mic setup page:
     - Go to `chrome-extension://[extension-id]/mic_setup.html`
     - Or click the confirmation dialog that appears when permission is blocked
   - Click "Enable microphone" and choose **Allow**

3. **Manually enable in Chrome settings:**
   - Open `chrome://settings/content/microphone`
   - Find your extension ID: `chrome-extension://[extension-id]`
   - Ensure it's set to **Allow**
   - Extension ID can be found in `chrome://extensions/` (Developer mode must be enabled)

4. **Check system microphone settings:**
   - Ensure your microphone is connected and working
   - Check Windows/Mac system settings for microphone access
   - Test microphone in other applications

### 2. OpenAI API Key Not Set

**Symptoms:**
- Error: "OpenAI API key not set. Click the mic and enter your key."
- Prompt appears asking for API key

**Solutions:**

1. **Enter your API key:**
   - Click the mic button
   - When prompted, enter your OpenAI API key
   - The key is stored locally in Chrome storage (not sent anywhere except OpenAI)

2. **Get an OpenAI API key:**
   - Go to https://platform.openai.com/api-keys
   - Sign up or log in
   - Create a new API key
   - Copy and paste it when prompted

3. **Verify key is stored:**
   - Open Chrome DevTools (F12)
   - Go to Application → Storage → Local Storage
   - Look for `openaiApiKey` (extension storage is separate)

### 3. Audio Recording Too Short

**Symptoms:**
- Error: "Recorded audio was empty/too short. Try recording for 1–2 seconds."
- Transcription fails immediately after stopping

**Solutions:**

1. **Record longer:**
   - Record for at least 1–2 seconds
   - Wait until you see "Recording… click mic to stop" before speaking
   - Speak clearly and wait a moment before clicking stop

2. **Check microphone input:**
   - Ensure microphone is picking up sound
   - Check system volume/microphone levels
   - Test in other applications

### 4. Whisper API Errors

**Symptoms:**
- Error: "Whisper STT failed (401): ..." (authentication error)
- Error: "Whisper STT failed (429): ..." (rate limit)
- Error: "Whisper STT failed (500): ..." (server error)

**Solutions:**

1. **401 Unauthorized:**
   - Your API key is invalid or expired
   - Generate a new API key from OpenAI
   - Re-enter the key when clicking the mic button

2. **429 Rate Limit:**
   - You've exceeded OpenAI's rate limits
   - Wait a few minutes and try again
   - Consider upgrading your OpenAI plan

3. **500 Server Error:**
   - OpenAI's servers are experiencing issues
   - Wait a few minutes and try again
   - Check OpenAI status page

4. **Network errors:**
   - Check your internet connection
   - Ensure firewall/proxy isn't blocking `api.openai.com`
   - Try again after a moment

### 5. Offscreen Document Issues

**Symptoms:**
- Error: "Offscreen API not available"
- Recording doesn't start
- Extension context invalidated errors

**Solutions:**

1. **Reload the extension:**
   - Go to `chrome://extensions/`
   - Find Glazyr extension
   - Click the reload icon (↻)

2. **Check Chrome version:**
   - Offscreen API requires Chrome 109+
   - Update Chrome if needed

3. **Restart Chrome:**
   - Close all Chrome windows
   - Restart Chrome
   - Try again

### 6. Widget/Iframe Issues

**Symptoms:**
- Mic button doesn't appear
- Mic button appears but doesn't work
- "Mic UI error" message

**Solutions:**

1. **Refresh the widget:**
   - Close and reopen the widget
   - The mic button is injected dynamically and may need time to appear

2. **Check iframe permissions:**
   - Some websites block microphone access in iframes
   - Try on a different website
   - The extension uses an offscreen document to work around this

3. **Check browser console:**
   - Open DevTools (F12) in the widget iframe
   - Look for JavaScript errors
   - Check for permission-related errors

## Debugging Steps

### Step 1: Check Status Messages

Watch the status panel at the top of the widget for messages:
- "Requesting microphone…" - Permission being requested
- "Recording… click mic to stop." - Recording active
- "Stopping…" - Recording stopping
- "Transcribing…" - Sending to Whisper API
- "STT inserted. Edit if needed, then Send." - Success!

### Step 2: Check Chrome DevTools

1. **Open DevTools:**
   - Right-click the widget → Inspect
   - Or press F12

2. **Check Console:**
   - Look for error messages
   - Check for permission errors
   - Look for network errors

3. **Check Network Tab:**
   - When you stop recording, you should see a request to `api.openai.com/v1/audio/transcriptions`
   - Check the response status and body

### Step 3: Check Extension Background Page

1. **Open background page:**
   - Go to `chrome://extensions/`
   - Find Glazyr extension
   - Click "service worker" or "background page" link

2. **Check console:**
   - Look for STT-related errors
   - Check for API key issues
   - Look for offscreen document errors

### Step 4: Verify Storage

1. **Check API key storage:**
   - In background page DevTools: Application → Storage → Local Storage
   - Look for `openaiApiKey`
   - Should contain your API key (starts with `sk-`)

2. **Check extension storage:**
   - Use Chrome DevTools console:
   ```javascript
   chrome.storage.local.get(['openaiApiKey'], (result) => {
     console.log('API Key stored:', result.openaiApiKey ? 'Yes' : 'No');
   });
   ```

## Testing the STT Feature

1. **Basic test:**
   - Open the widget
   - Click the mic button (🎙)
   - Grant permission if prompted
   - Speak clearly for 2-3 seconds
   - Click the mic button again to stop
   - Wait for transcription
   - Text should appear in the input field

2. **Verify API key:**
   - If prompted for API key, enter a valid OpenAI key
   - Key should be stored and not prompt again

3. **Test on different sites:**
   - Some sites block iframe microphone access
   - The extension should work around this using offscreen document
   - Try on different websites

## Error Messages Reference

| Error Message | Cause | Solution |
|--------------|-------|----------|
| "Microphone permission was dismissed/denied" | Permission not granted | Use mic setup page or Chrome settings |
| "OpenAI API key not set" | No API key stored | Enter API key when prompted |
| "Recorded audio was empty/too short" | Recording too brief | Record for 1-2+ seconds |
| "Whisper STT failed (401)" | Invalid API key | Generate new key from OpenAI |
| "Whisper STT failed (429)" | Rate limit exceeded | Wait and try again |
| "Offscreen API not available" | Chrome version too old | Update Chrome to 109+ |
| "STT error" | Generic error | Check console for details |

## Getting Help

If you've tried all troubleshooting steps and STT still doesn't work:

1. **Check the browser console** for detailed error messages
2. **Check the background page console** for service worker errors
3. **Verify your OpenAI API key** is valid and has credits
4. **Test microphone** in other applications
5. **Check Chrome version** (should be 109+)
6. **Try on a different website** (some sites block iframe permissions)

## Technical Details

### Architecture

1. **User clicks mic button** → `popup_actions.js` sends `STT_RECORD_START`
2. **Background worker** creates/uses offscreen document
3. **Offscreen document** (`offscreen.js`) records audio using `getUserMedia`
4. **Audio recorded** → sent back to background as `OFFSCREEN_AUDIO_READY`
5. **Background worker** calls `transcribeWhisper()` → sends to OpenAI Whisper API
6. **Transcription result** → sent to widget as `STT_RESULT`
7. **Widget** inserts text into input field

### Storage

- API key stored in `chrome.storage.local` under key `openaiApiKey`
- Stored locally, never sent to any server except OpenAI

### Permissions

- Extension requires `offscreen` permission (for offscreen document)
- Microphone permission requested at runtime (not in manifest)
- Uses offscreen document to avoid site Permissions-Policy restrictions
