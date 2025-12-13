(() => {
  console.log("Glazyr Service Worker started.")

  /** @type {Array<{url:string,title:string,text:string,timestamp:number}>} */
  const contextBuffer = []

  function safeRuntimeSendMessage(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => {
        // ignore when popup isn't open
        void chrome.runtime.lastError
      })
    } catch {
      // ignore
    }
  }

  const OPENAI_KEY_STORAGE = "openaiApiKey"

  async function getOpenAIKey() {
    return await new Promise((resolve) => {
      chrome.storage.local.get([OPENAI_KEY_STORAGE], (res) => resolve(res?.[OPENAI_KEY_STORAGE] || ""))
    })
  }

  function guessAudioFileName(mimeType) {
    if (!mimeType) return "audio.webm"
    const mt = mimeType.toLowerCase()
    if (mt.includes("ogg")) return "audio.ogg"
    if (mt.includes("wav")) return "audio.wav"
    if (mt.includes("mpeg") || mt.includes("mp3")) return "audio.mp3"
    if (mt.includes("mp4") || mt.includes("m4a")) return "audio.m4a"
    return "audio.webm"
  }

  async function transcribeWhisper({ audio, mimeType }) {
    const apiKey = await getOpenAIKey()
    if (!apiKey) throw new Error("OpenAI API key not set. Click the mic and enter your key.")
    if (!audio) throw new Error("No audio provided.")

    const blob = new Blob([audio], { type: mimeType || "audio/webm" })
    const form = new FormData()
    form.append("model", "whisper-1")
    form.append("file", blob, guessAudioFileName(mimeType))

    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
    })

    const text = await resp.text()
    if (!resp.ok) throw new Error(`Whisper STT failed (${resp.status}): ${text}`)

    const json = JSON.parse(text)
    return String(json?.text || "")
  }

  async function ensureOffscreenDocument() {
    if (!chrome?.offscreen?.createDocument) throw new Error("Offscreen API not available.")
    const has = chrome.offscreen.hasDocument ? await chrome.offscreen.hasDocument() : false
    if (has) return
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Record microphone audio for Whisper STT from the extension UI.",
    })
  }

  async function dataUrlToBlob(dataUrl) {
    const res = await fetch(dataUrl)
    return await res.blob()
  }

  async function blobToDataUrl(blob) {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(reader.error)
      reader.onload = () => resolve(reader.result)
      reader.readAsDataURL(blob)
    })
  }

  async function cropDataUrlToPng(dataUrl, rectCssPx, dpr) {
    if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") {
      throw new Error("Cropping not supported in this browser context.")
    }

    const blob = await dataUrlToBlob(dataUrl)
    const bitmap = await createImageBitmap(blob)
    const sx = Math.round(rectCssPx.x * dpr)
    const sy = Math.round(rectCssPx.y * dpr)
    const sw = Math.round(rectCssPx.width * dpr)
    const sh = Math.round(rectCssPx.height * dpr)

    const canvas = new OffscreenCanvas(sw, sh)
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("No 2D context available for cropping.")

    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh)
    const outBlob = await canvas.convertToBlob({ type: "image/png" })
    return await blobToDataUrl(outBlob)
  }

  function mockAnalyzeImage(source) {
    return `Glazyr AI Mock: Received a framed screenshot (${source}). Ready for vision analysis.`
  }

  function requestRegionSelect(tabId) {
    chrome.tabs.sendMessage(tabId, { type: "BEGIN_REGION_SELECT" }, () => {
      const err = chrome.runtime.lastError
      if (!err) return
      // If the content script isn't present (e.g. tab opened before extension update),
      // inject the region selection script and retry.
      if (chrome?.scripting?.executeScript) {
        chrome.scripting.executeScript(
          { target: { tabId }, files: ["region_select_content.js"] },
          () => {
            chrome.tabs.sendMessage(tabId, { type: "BEGIN_REGION_SELECT" }, () => {
              void chrome.runtime.lastError
            })
          }
        )
      }
    })
    safeRuntimeSendMessage({
      type: "CAPTURE_HINT",
      text: "Drag to select an area on the page, then release to capture (Esc to cancel).",
    })
  }

  async function handleRegionSelected(sender, payload) {
    const tabId = sender?.tab?.id
    const windowId = sender?.tab?.windowId
    if (!tabId || typeof windowId !== "number") throw new Error("No active tab/window for capture.")

    const { rect, devicePixelRatio } = payload || {}
    if (!rect || !rect.width || !rect.height) throw new Error("Invalid selection rectangle.")

    safeRuntimeSendMessage({ type: "CAPTURE_STARTED" })

    const screenshotDataUrl = await new Promise((resolve, reject) => {
      chrome.tabs.captureVisibleTab(
        windowId,
        { format: "png" },
        (dataUrl) => {
          const err = chrome.runtime.lastError
          if (err) return reject(new Error(err.message))
          if (!dataUrl) return reject(new Error("No screenshot data returned."))
          resolve(dataUrl)
        }
      )
    })

    const croppedDataUrl = await cropDataUrlToPng(
      screenshotDataUrl,
      rect,
      devicePixelRatio || 1
    )

    safeRuntimeSendMessage({ type: "CAPTURE_DONE", imageDataUrl: croppedDataUrl })

    // Analyze (mock for now) and report back to popup and page
    const analysisText = mockAnalyzeImage("crop_capture")
    await chrome.storage.local.set({
      lastCapture: { imageDataUrl: croppedDataUrl, analysisText, ts: Date.now() },
    })

    safeRuntimeSendMessage({ type: "ANALYSIS_RESULT", text: analysisText, imageDataUrl: croppedDataUrl })
    chrome.tabs.sendMessage(tabId, { type: "AI_RESPONSE", text: analysisText }, () => {
      void chrome.runtime.lastError
    })
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Page context buffer
    if (msg?.type === "PAGE_CONTEXT") {
      const ctx = {
        url: msg.url,
        title: msg.title,
        text: msg.text,
        timestamp: Date.now(),
      }
      contextBuffer.unshift(ctx)
      if (contextBuffer.length > 5) contextBuffer.pop()
      chrome.storage.local.set({ contextBuffer })
      console.log(`New context added. Buffer size: ${contextBuffer.length}`)
      sendResponse({ status: "Context received" })
      return true
    }

    // Drag-drop image analysis
    if (msg?.type === "IMAGE_FOR_ANALYSIS") {
      console.log(`Image received for analysis from ${msg.source}.`)
      const text = `Glazyr AI Mock: Image from ${msg.source} received. It is ready for vision analysis.`
      sendResponse({ status: "Image received for analysis" })
      safeRuntimeSendMessage({ type: "ANALYSIS_RESULT", text })
      if (sender?.tab?.id) {
        chrome.tabs.sendMessage(sender.tab.id, { type: "AI_RESPONSE", text }, () => void chrome.runtime.lastError)
      }
      return true
    }

    // Region selection result -> capture + crop
    if (msg?.type === "REGION_SELECTED") {
      handleRegionSelected(sender, msg).then(
        () => sendResponse({ status: "ok" }),
        (err) => {
          console.error("Capture/crop failed:", err)
          safeRuntimeSendMessage({ type: "ANALYSIS_ERROR", text: String(err?.message || err) })
          sendResponse({ status: "error", error: String(err?.message || err) })
        }
      )
      return true
    }

    if (msg?.type === "USER_INPUT") {
      console.log("User input captured:", msg.details)
      return true
    }

    if (msg?.type === "GET_LAST_CAPTURE") {
      chrome.storage.local.get(["lastCapture"], (res) => {
        sendResponse({ lastCapture: res?.lastCapture || null })
      })
      return true
    }

    if (msg?.type === "STT_TRANSCRIBE") {
      transcribeWhisper({ audio: msg.audio, mimeType: msg.mimeType }).then(
        (text) => sendResponse({ ok: true, text }),
        (err) => sendResponse({ ok: false, error: String(err?.message || err) })
      )
      return true
    }

    // New STT flow (record in offscreen doc to avoid site Permissions-Policy)
    if (msg?.type === "STT_RECORD_START") {
      ensureOffscreenDocument()
        .then(() => {
          safeRuntimeSendMessage({ type: "STT_STATUS", text: "Requesting microphone…" })
          chrome.runtime.sendMessage({ type: "OFFSCREEN_RECORD_START" }, (res) => {
            if (chrome.runtime.lastError) {
              sendResponse({ ok: false, error: chrome.runtime.lastError.message })
              return
            }
            if (!res?.ok) {
              sendResponse({ ok: false, error: res?.error || "Failed to start recording." })
              return
            }
            safeRuntimeSendMessage({ type: "STT_STATUS", text: "Recording… click mic to stop." })
            sendResponse({ ok: true })
          })
        })
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }))
      return true
    }

    if (msg?.type === "STT_RECORD_STOP") {
      ensureOffscreenDocument()
        .then(() => {
          safeRuntimeSendMessage({ type: "STT_STATUS", text: "Stopping…" })
          chrome.runtime.sendMessage({ type: "OFFSCREEN_RECORD_STOP" }, (res) => {
            if (chrome.runtime.lastError) {
              sendResponse({ ok: false, error: chrome.runtime.lastError.message })
              return
            }
            if (!res?.ok) {
              sendResponse({ ok: false, error: res?.error || "Failed to stop recording." })
              return
            }
            safeRuntimeSendMessage({ type: "STT_STATUS", text: "Transcribing…" })
            sendResponse({ ok: true })
          })
        })
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }))
      return true
    }

    if (msg?.type === "OFFSCREEN_AUDIO_READY") {
      transcribeWhisper({ audio: msg.audio, mimeType: msg.mimeType }).then(
        (text) => {
          safeRuntimeSendMessage({ type: "STT_RESULT", text })
        },
        (err) => {
          safeRuntimeSendMessage({ type: "STT_ERROR", text: String(err?.message || err) })
        }
      )
      sendResponse?.({ ok: true })
      return true
    }

    if (msg?.type === "USER_QUERY") {
      const query = String(msg.query || "")
      const ctx = contextBuffer[0]
      if (!ctx) {
        sendResponse({ type: "AI_RESPONSE", text: "No page context available. Please navigate to a webpage first." })
        return true
      }

      const q = query.toLowerCase()
      console.log(`AI Mock processing query: "${query}" on page: ${ctx.title}`)

      if (sender?.tab?.id && (q.includes("framed screenshot") || q.includes("crop capture") || q.includes("crop") || q.includes("frame"))) {
        requestRegionSelect(sender.tab.id)
        sendResponse({ type: "AI_RESPONSE", text: "Framed screenshot: drag to select an area, then release to capture." })
        return true
      }

      if (q.includes("screenshot")) {
        // Full viewport screenshot (not cropped)
        chrome.tabs.captureVisibleTab({ format: "jpeg", quality: 90 }, (dataUrl) => {
          const err = chrome.runtime.lastError
          if (err) console.error("Error capturing screenshot:", err.message)
          else console.log(`Screenshot captured. Data URL length: ${dataUrl?.length || 0}`)
        })
        sendResponse({
          type: "AI_RESPONSE",
          text: "Attempting to capture screenshot... (check extension console for status)",
        })
        return true
      }

      if (q.includes("summary")) {
        sendResponse({
          type: "AI_RESPONSE",
          text: `AI Summary: This page, titled "${ctx.title}", is about a topic that I have analyzed. The content is approximately ${ctx.text.length} characters long.`,
        })
        return true
      }

      if (q.includes("click")) {
        const selector = "#mock-button"
        if (sender?.tab?.id) {
          chrome.tabs.sendMessage(sender.tab.id, { type: "EXECUTE_ACTION", action: "click", selector }, () => void chrome.runtime.lastError)
        }
        sendResponse({
          type: "AI_RESPONSE",
          text: `AI Action: I have instructed the content script to click the element with selector "${selector}".`,
        })
        return true
      }

      sendResponse({
        type: "AI_RESPONSE",
        text: `AI Response: Thank you for your query about "${query}". (Mock)`,
      })
      return true
    }
  })

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "ACTION_EXECUTED") {
      console.log(`Action executed successfully: ${msg.action} on selector ${msg.selector}`)
      sendResponse({ status: "ACK" })
      return true
    }
  })

  // Make the extension icon open/close the in-page widget (no action popup).
  chrome.action.onClicked.addListener((tab) => {
    const tabId = tab?.id
    if (!tabId) return
    const url = String(tab?.url || "")

    // Chrome blocks extensions from injecting into internal pages.
    const isRestricted =
      url.startsWith("chrome://") ||
      url.startsWith("chrome-extension://") ||
      url.startsWith("edge://") ||
      url.startsWith("about:") ||
      url.startsWith("view-source:") ||
      url.startsWith("devtools://") ||
      url.startsWith("chrome.google.com/webstore")

    if (isRestricted) {
      chrome.action.setBadgeText({ tabId, text: "X" })
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#c62828" })
      chrome.action.setTitle({
        tabId,
        title: "Glazyr: can't open widget on this page (chrome:// and other restricted URLs). Open any normal website.",
      })
      return
    }

    // First try: message the already-injected content script.
    chrome.tabs.sendMessage(tabId, { type: "TOGGLE_WIDGET" }, () => {
      const err = chrome.runtime.lastError
      if (!err) return

      // If no receiver (tab opened before update / content script not present), inject then retry.
      if (chrome?.scripting?.executeScript) {
        chrome.scripting.executeScript(
          { target: { tabId }, files: ["widget_content.js"] },
          () => {
            chrome.tabs.sendMessage(tabId, { type: "TOGGLE_WIDGET" }, () => {
              void chrome.runtime.lastError
            })
          }
        )
      }
    })
  })
})()