(() => {
  console.log("Glazyr Service Worker started.")

  /** @type {Array<{url:string,title:string,text:string,timestamp:number}>} */
  const contextBuffer = []

  // --- Runtime backend (Lambda Function URL) integration ---
  const RUNTIME_BASE_URL_STORAGE = "glazyrRuntimeBaseUrl"
  const RUNTIME_API_KEY_STORAGE = "glazyrRuntimeApiKey"
  const DEVICE_ID_STORAGE = "glazyrDeviceId"

  // Default to the provisioned runtime URL (can be overridden via chrome.storage.local).
  const DEFAULT_RUNTIME_BASE_URL = "https://lxunoqp6dwzwfllsnnxxwsqqaq0vqnhp.lambda-url.us-east-1.on.aws"

  /** @type {number|null} */
  let lastActiveTabId = null

  /** @type {Map<string, {deviceId:string,taskId:string,stepId:string,requestId:string,ts:number}>} */
  const inflightRuntime = new Map()

  function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, (res) => resolve(res || {})))
  }

  async function ensureDeviceId() {
    const res = await storageGet([DEVICE_ID_STORAGE])
    const existing = String(res?.[DEVICE_ID_STORAGE] || "").trim()
    if (existing) return existing
    const id = crypto.randomUUID()
    await chrome.storage.local.set({ [DEVICE_ID_STORAGE]: id })
    return id
  }

  async function getRuntimeConfig() {
    const deviceId = await ensureDeviceId()
    const res = await storageGet([RUNTIME_BASE_URL_STORAGE, RUNTIME_API_KEY_STORAGE])
    const baseUrl = String(res?.[RUNTIME_BASE_URL_STORAGE] || DEFAULT_RUNTIME_BASE_URL).replace(/\/+$/, "")
    const apiKey = String(res?.[RUNTIME_API_KEY_STORAGE] || "")
    return { baseUrl, apiKey, deviceId }
  }

  async function runtimeFetch(path, opts) {
    const { baseUrl, apiKey } = await getRuntimeConfig()
    const url = `${baseUrl}${path}`
    const headers = { "content-type": "application/json" }
    if (apiKey) headers["x-glazyr-api-key"] = apiKey

    const res = await fetch(url, {
      method: opts?.method || "GET",
      headers,
      body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })

    if (res.status === 204) return { status: 204, data: null }

    const text = await res.text().catch(() => "")
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }

    if (!res.ok) {
      const msg = typeof data?.error === "string" ? data.error : `Runtime request failed (${res.status})`
      throw new Error(msg)
    }

    return { status: res.status, data }
  }

  async function startRuntimeTask(intent, ctx) {
    const { deviceId } = await getRuntimeConfig()
    const payload = {
      deviceId,
      intent: String(intent || "").trim(),
      url: String(ctx?.url || ""),
      title: String(ctx?.title || ""),
    }
    return await runtimeFetch("/runtime/task/start", { method: "POST", body: payload })
  }

  async function pollRuntimeOnce() {
    if (!lastActiveTabId) return
    const { deviceId } = await getRuntimeConfig()
    const res = await runtimeFetch(`/runtime/next-action?deviceId=${encodeURIComponent(deviceId)}`)
    if (res.status === 204 || !res.data) return

    const msg = res.data
    const requestId = String(msg.requestId || "")
    const taskId = String(msg.taskId || "")
    const stepId = String(msg.stepId || "")
    const ts = Number(msg.ts || 0)
    const action = msg.action || {}

    if (!requestId || !taskId || !stepId || !ts) return

    // Currently we support only click (MVP).
    if (String(action.type || "").toLowerCase() !== "click") return

    inflightRuntime.set(requestId, { deviceId, taskId, stepId, requestId, ts })

    const selector = String(action.selector || "#mock-button")

    chrome.tabs.sendMessage(
      lastActiveTabId,
      { type: "EXECUTE_ACTION", action: "click", selector, requestId, taskId, stepId, ts },
      async (resp) => {
        void chrome.runtime.lastError

        // If the content script blocks locally, complete with failure immediately.
        if (resp?.status === "blocked") {
          try {
            await runtimeFetch("/runtime/action-result", {
              method: "POST",
              body: { deviceId, taskId, stepId, requestId, ts, success: false, error: String(resp.error || "Blocked") },
            })
          } catch {}
          inflightRuntime.delete(requestId)
        }
      }
    )
  }

  // Poll the runtime while the extension is active.
  setInterval(() => {
    pollRuntimeOnce().catch(() => {})
  }, 1500)

  // --- Control-plane policy (best-effort enforcement) ---
  const CONTROL_PLANE_CONFIG_KEY = "glazyrControlPlaneConfig"
  const KILLSWITCH_KEY = "glazyrKillSwitch"

  /** @type {{ killSwitchEngaged: boolean, agentMode: "observe"|"assist"|"automate", allowedDomains: string[], disallowedActions: string[] }} */
  let policyCache = { killSwitchEngaged: false, agentMode: "observe", allowedDomains: [], disallowedActions: [] }

  function normalizeDomain(input) {
    const raw = String(input || "").trim().toLowerCase()
    if (!raw) return ""
    // Strip scheme if present.
    const noScheme = raw.replace(/^[a-z]+:\/\//i, "")
    // Strip path/query/hash.
    const hostAndMaybePort = noScheme.split("/")[0]
    // Strip port.
    const host = hostAndMaybePort.split(":")[0]
    return host
  }

  function hostMatchesPattern(host, pattern) {
    const h = normalizeDomain(host)
    const p = normalizeDomain(pattern)
    if (!h || !p) return false
    if (p === "*") return true
    if (p.startsWith("*.")) {
      const root = p.slice(2)
      return h === root || h.endsWith("." + root)
    }
    // Allow subdomains if the root is provided (example.com matches foo.example.com).
    return h === p || h.endsWith("." + p)
  }

  function urlAllowed(url, allowedDomains) {
    const list = Array.isArray(allowedDomains) ? allowedDomains : []
    if (!list.length) return true // no restriction configured
    try {
      const u = new URL(String(url || ""))
      const host = u.hostname || ""
      return list.some((d) => hostMatchesPattern(host, d))
    } catch {
      return false
    }
  }

  function actionDisallowed(actionType, disallowedActions) {
    const a = String(actionType || "").trim().toLowerCase()
    const list = Array.isArray(disallowedActions) ? disallowedActions : []
    return list.some((x) => String(x || "").trim().toLowerCase() === a)
  }

  async function refreshPolicyCache() {
    return await new Promise((resolve) => {
      chrome.storage.local.get([CONTROL_PLANE_CONFIG_KEY, KILLSWITCH_KEY], (res) => {
        const cfg = res?.[CONTROL_PLANE_CONFIG_KEY]
        const ks = res?.[KILLSWITCH_KEY]
        const ksEngaged = !!(ks?.engaged || cfg?.killSwitchEngaged)
        policyCache = {
          killSwitchEngaged: ksEngaged,
          agentMode: (cfg?.agentMode === "assist" || cfg?.agentMode === "automate" || cfg?.agentMode === "observe") ? cfg.agentMode : "observe",
          allowedDomains: Array.isArray(cfg?.safety?.allowedDomains) ? cfg.safety.allowedDomains : [],
          disallowedActions: Array.isArray(cfg?.safety?.disallowedActions) ? cfg.safety.disallowedActions : [],
        }
        resolve(policyCache)
      })
    })
  }

  // Keep a warm cache when the service worker is alive.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return
      if (changes?.[CONTROL_PLANE_CONFIG_KEY] || changes?.[KILLSWITCH_KEY]) {
        void refreshPolicyCache()
      }
    })
  } catch {
    // ignore
  }

  async function checkPolicyOrThrow(sender, actionType) {
    await refreshPolicyCache()
    const url = String(sender?.tab?.url || "")

    if (!urlAllowed(url, policyCache.allowedDomains)) {
      throw new Error("Blocked by policy: domain is not in allowed domains.")
    }

    if (policyCache.killSwitchEngaged) {
      throw new Error("Blocked by policy: kill switch is engaged.")
    }

    // Observe mode is read-only: disallow actions that change state.
    const act = String(actionType || "").toLowerCase()
    const mutating = act === "click" || act === "type" || act === "navigate" || act === "submit"
    if (policyCache.agentMode === "observe" && mutating) {
      throw new Error("Blocked by policy: agent mode is Observe (read-only).")
    }

    if (actionDisallowed(act, policyCache.disallowedActions)) {
      throw new Error(`Blocked by policy: action "${act}" is disallowed.`)
    }
  }

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

  function normalizeAudioMimeType(mimeType) {
    const mt = String(mimeType || "").toLowerCase()
    if (!mt) return "audio/webm"
    if (mt.includes("webm")) return "audio/webm"
    if (mt.includes("ogg")) return "audio/ogg"
    if (mt.includes("wav")) return "audio/wav"
    if (mt.includes("mpeg") || mt.includes("mp3")) return "audio/mpeg"
    if (mt.includes("mp4") || mt.includes("m4a")) return "audio/mp4"
    return "audio/webm"
  }

  function coerceToUint8Array(data) {
    if (!data) return null
    if (data instanceof Uint8Array) return data
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer)
    if (data instanceof ArrayBuffer) return new Uint8Array(data)
    return null
  }

  async function transcribeWhisper({ audioBytes, mimeType }) {
    const apiKey = await getOpenAIKey()
    if (!apiKey) throw new Error("OpenAI API key not set. Click the mic and enter your key.")
    const bytesArr = coerceToUint8Array(audioBytes)
    if (!bytesArr) throw new Error("No audio bytes provided.")
    const bytes = bytesArr.byteLength || 0
    if (bytes && bytes < 2048) throw new Error("Recorded audio was empty/too short. Try recording for 1–2 seconds.")

    const normalizedType = normalizeAudioMimeType(mimeType)
    const blob = new Blob([bytesArr], { type: normalizedType })
    const form = new FormData()
    form.append("model", "whisper-1")
    form.append("file", blob, guessAudioFileName(normalizedType))

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

  async function resetOffscreenDocument() {
    if (!chrome?.offscreen?.createDocument) return
    try {
      const has = chrome.offscreen.hasDocument ? await chrome.offscreen.hasDocument() : false
      if (has && chrome.offscreen.closeDocument) {
        await chrome.offscreen.closeDocument()
      }
    } catch {
      // ignore
    }
    await ensureOffscreenDocument()
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

  async function analyzeImageWithRuntimeOcr(imageDataUrl) {
    const res = await runtimeFetch("/runtime/vision/ocr", { method: "POST", body: { imageDataUrl } })
    const text = String(res?.data?.text || "")
    return text
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
    await checkPolicyOrThrow(sender, "screenshot")
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

    // Analyze (OCR via runtime) and report back to popup and page (fallback to mock).
    let analysisText = ""
    try {
      const ocrText = await analyzeImageWithRuntimeOcr(croppedDataUrl)
      const trimmed = String(ocrText || "").trim()
      analysisText = trimmed ? `OCR:\n${trimmed.slice(0, 8000)}` : "OCR: No text detected."
    } catch (e) {
      analysisText = `OCR error: ${String(e?.message || e)}`
    }
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

    // Allow in-page launcher button (content script) to toggle the widget.
    if (msg?.type === "TOGGLE_WIDGET" && sender?.tab?.id) {
      chrome.tabs.sendMessage(sender.tab.id, { type: "TOGGLE_WIDGET" }, () => void chrome.runtime.lastError)
      sendResponse?.({ status: "ok" })
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
      // Ensure we run the latest offscreen recorder code after updates.
      resetOffscreenDocument()
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
      // Back-compat: older offscreen recorders sent `audio` (ArrayBuffer) instead of `audioBytes` (Uint8Array)
      const audioPayload = msg.audioBytes ?? msg.audio
      transcribeWhisper({ audioBytes: audioPayload, mimeType: msg.mimeType }).then(
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
      const q = query.toLowerCase()

      function normalizeQuery(input) {
        return String(input || "")
          .toLowerCase()
          .replace(/[’']/g, "") // normalize apostrophes
          .replace(/[^a-z0-9\s]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      }

      const nq = normalizeQuery(query)
      const nqNoSpace = nq.replace(/\s+/g, "")

      // Quick debug hook: ask "glazyr debug" to confirm the running background script has the latest logic.
      if (nq === "glazyr debug") {
        sendResponse({
          type: "AI_RESPONSE",
          text:
            "Glazyr debug:\n" +
            "- background: ocr-in-chat + page-about matcher v2\n" +
            `- normalizedQuery: "${nq}"`,
        })
        return true
      }

      // OCR doesn't require page context; allow it even on restricted pages if we have a last capture.
      const wantsOcr =
        q.includes("ocr") ||
        q.includes("read the screenshot") ||
        q.includes("text in the screenshot") ||
        q.includes("text in this screenshot") ||
        q.includes("what's the text") ||
        q.includes("whats the text") ||
        q.includes("what in the image") ||
        q.includes("what's in the image") ||
        q.includes("whats in the image") ||
        q.includes("what is in the image") ||
        q.includes("what's on the screenshot") ||
        q.includes("whats on the screenshot") ||
        q.includes("what's on this screenshot") ||
        q.includes("whats on this screenshot") ||
        q.includes("what's on this screen") ||
        q.includes("whats on this screen")

      if (wantsOcr) {
        chrome.storage.local.get(["lastCapture"], (res) => {
          const last = res?.lastCapture
          const imageDataUrl = String(last?.imageDataUrl || "")
          if (!imageDataUrl) {
            sendResponse({ type: "AI_RESPONSE", text: "No capture found yet. Click “Framed shot” first." })
            return
          }
          analyzeImageWithRuntimeOcr(imageDataUrl).then(
            (text) => {
              const trimmed = String(text || "").trim()
              sendResponse({ type: "AI_RESPONSE", text: trimmed ? trimmed.slice(0, 8000) : "No text detected." })
            },
            (err) => sendResponse({ type: "AI_RESPONSE", text: String(err?.message || err) })
          )
        })
        return true
      }

      const ctx = contextBuffer[0]
      if (!ctx) {
        // We can still be helpful without page context: use the last OCR/capture if present,
        // and provide clear instructions for restoring context buffering.
        chrome.storage.local.get(["lastCapture"], (res) => {
          const last = res?.lastCapture
          const analysisText = String(last?.analysisText || "").trim()

          const guidance =
            "I don’t have page context yet.\n\n" +
            "To enable it:\n" +
            "1) Switch to a normal website tab (not chrome://, edge://, about:, or the Web Store).\n" +
            "2) Refresh the page once.\n" +
            "3) Re-open the widget and ask again.\n\n" +
            "Tip: You can still use “Framed shot” for OCR on any page you can capture."

          if (analysisText) {
            const raw = analysisText.replace(/^OCR:\s*/i, "").trim()
            const looksLikeList =
              raw.length > 0 &&
              (raw.includes("WebControlPlane") ||
                raw.includes("killSwitch") ||
                raw.includes("ChromeExtension") ||
                raw.includes("Runtime") ||
                raw.split(/\s+/).length >= 8)

            // If the user is asking a follow-up like "what's that about?", interpret the OCR text.
            const isFollowup =
              q.includes("what's that about") ||
              q.includes("whats that about") ||
              q === "what about that" ||
              q.includes("what is that") ||
              q.includes("whats that") ||
              q.includes("what's this") ||
              q.includes("whats this")

            if (isFollowup && looksLikeList) {
              sendResponse({
                type: "AI_RESPONSE",
                text:
                  "Based on the last screenshot OCR, this looks like a high-level list of Glazyr components/modules " +
                  "(dashboard UI, kill switch, web control plane APIs, extension heartbeat, runtime, safety enforcement, etc.).\n\n" +
                  `OCR text snippet:\n${raw.slice(0, 500)}`,
              })
              return
            }

            // Otherwise, surface OCR + guidance.
            sendResponse({
              type: "AI_RESPONSE",
              text: `I don’t have page context yet, but here’s what I extracted from the last screenshot:\n\n${raw.slice(0, 1200)}\n\n${guidance}`,
            })
            return
          }

          sendResponse({ type: "AI_RESPONSE", text: guidance })
        })
        return true
      }

      if (sender?.tab?.id) lastActiveTabId = sender.tab.id

      console.log(`AI Mock processing query: "${query}" on page: ${ctx.title}`)

      if (sender?.tab?.id && (q.includes("framed screenshot") || q.includes("crop capture") || q.includes("crop") || q.includes("frame"))) {
        checkPolicyOrThrow(sender, "screenshot").then(
          () => {
            requestRegionSelect(sender.tab.id)
            sendResponse({ type: "AI_RESPONSE", text: "Framed screenshot: drag to select an area, then release to capture." })
          },
          (err) => {
            sendResponse({ type: "AI_RESPONSE", text: String(err?.message || err) })
          }
        )
        return true
      }

      if (q.includes("screenshot")) {
        checkPolicyOrThrow(sender, "screenshot").then(
          () => {
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
          },
          (err) => {
            sendResponse({ type: "AI_RESPONSE", text: String(err?.message || err) })
          }
        )
        return true
      }

      if (q.includes("summary")) {
        sendResponse({
          type: "AI_RESPONSE",
          text: `AI Summary: This page, titled "${ctx.title}", is about a topic that I have analyzed. The content is approximately ${ctx.text.length} characters long.`,
        })
        return true
      }

      // Common "summary" phrasing that doesn't include the word "summary".
      if (
        nq.includes("whats this page about") ||
        nq.includes("what is this page about") ||
        nq.includes("whats this site about") ||
        nq.includes("what is this site about") ||
        nq.includes("whats this webpage about") ||
        nq.includes("what is this webpage about") ||
        nq.includes("whats this website about") ||
        nq.includes("what is this website about") ||
        nq.includes("page about") ||
        // Handle missing spaces: "pageabout", "whatsthispageabout"
        nqNoSpace.includes("pageabout") ||
        nqNoSpace.includes("whatsthispageabout") ||
        nqNoSpace.includes("whatisthispageabout")
      ) {
        const snippet = String(ctx.text || "").trim().slice(0, 280)
        sendResponse({
          type: "AI_RESPONSE",
          text:
            `This page (“${ctx.title}”) appears to be about:\n\n` +
            (snippet ? `${snippet}${snippet.length >= 280 ? "…" : ""}\n\n` : "") +
            `If you want a tighter summary, ask “give me a summary”.`,
        })
        return true
      }

      if (q.includes("click")) {
        const selector = "#mock-button"
        checkPolicyOrThrow(sender, "click").then(
          () => {
            if (sender?.tab?.id) {
              chrome.tabs.sendMessage(sender.tab.id, { type: "EXECUTE_ACTION", action: "click", selector }, () => void chrome.runtime.lastError)
            }
            sendResponse({
              type: "AI_RESPONSE",
              text: `AI Action: I have instructed the content script to click the element with selector "${selector}".`,
            })
          },
          (err) => {
            sendResponse({ type: "AI_RESPONSE", text: String(err?.message || err) })
          }
        )
        return true
      }

      // Default path: send the query to the runtime orchestrator for planning/execution.
      startRuntimeTask(query, ctx).then(
        () => sendResponse({ type: "AI_RESPONSE", text: "Queued in runtime. Waiting for next action…" }),
        (err) => sendResponse({ type: "AI_RESPONSE", text: String(err?.message || err) })
      )
      return true

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
      const requestId = String(msg.requestId || "")
      const inflight = requestId ? inflightRuntime.get(requestId) : null
      if (inflight) {
        runtimeFetch("/runtime/action-result", {
          method: "POST",
          body: {
            deviceId: inflight.deviceId,
            taskId: inflight.taskId,
            stepId: inflight.stepId,
            requestId: inflight.requestId,
            ts: inflight.ts,
            success: true,
            result: { action: msg.action, selector: msg.selector },
          },
        }).catch(() => {})
        inflightRuntime.delete(requestId)
      }
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