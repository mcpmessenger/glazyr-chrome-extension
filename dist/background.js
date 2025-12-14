(() => {
  console.log("Glazyr Service Worker started.")

  /** @type {Array<{url:string,title:string,text:string,timestamp:number}>} */
  const contextBuffer = []

  // --- Runtime backend (Lambda Function URL) integration ---
  const RUNTIME_BASE_URL_STORAGE = "glazyrRuntimeBaseUrl"
  const RUNTIME_API_KEY_STORAGE = "glazyrRuntimeApiKey"
  // MCP runtime (glazyr-control) integration (separate from vision runtime)
  const MCP_RUNTIME_BASE_URL_STORAGE = "glazyrMcpRuntimeBaseUrl"
  const MCP_RUNTIME_API_KEY_STORAGE = "glazyrMcpRuntimeApiKey"
  // Legacy orchestrator polling (deprecated; keep opt-in to avoid spam on MCP-only runtimes)
  const LEGACY_ORCHESTRATOR_ENABLED_STORAGE = "glazyrLegacyOrchestratorEnabled"
  const DEVICE_ID_STORAGE = "glazyrDeviceId"

  // Default to the provisioned runtime URL (can be overridden via chrome.storage.local).
  const DEFAULT_RUNTIME_BASE_URL = "https://lxunoqp6dwzwfllsnnxxwsqqaq0vqnhp.lambda-url.us-east-1.on.aws"
  // Default LangChain agents MCP runtime URL (hardcoded - can be overridden via chrome.storage.local).
  const DEFAULT_MCP_RUNTIME_BASE_URL = "https://langchain-agent-mcp-server-554655392699.us-central1.run.app"

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
    let baseUrl = String(res?.[RUNTIME_BASE_URL_STORAGE] || DEFAULT_RUNTIME_BASE_URL).replace(/\/+$/, "")
    // Normalize common misconfiguration: users sometimes paste a base URL that already ends with `/runtime`.
    // Our runtimeFetch() appends `/runtime/...` paths, so strip it to avoid 404s like `/runtime/runtime/...`.
    if (baseUrl.endsWith("/runtime")) baseUrl = baseUrl.slice(0, -"/runtime".length)
    const apiKey = String(res?.[RUNTIME_API_KEY_STORAGE] || "")
    return { baseUrl, apiKey, deviceId }
  }

  async function getMcpRuntimeConfig() {
    const deviceId = await ensureDeviceId()
    const res = await storageGet([
      MCP_RUNTIME_BASE_URL_STORAGE,
      MCP_RUNTIME_API_KEY_STORAGE,
      // fallback to legacy keys for easier setup
      RUNTIME_BASE_URL_STORAGE,
      RUNTIME_API_KEY_STORAGE,
    ])

    let baseUrl = String(
      res?.[MCP_RUNTIME_BASE_URL_STORAGE] || res?.[RUNTIME_BASE_URL_STORAGE] || DEFAULT_MCP_RUNTIME_BASE_URL || ""
    ).replace(/\/+$/, "")

    // Normalize common misconfiguration: strip "/mcp" if pasted.
    if (baseUrl.endsWith("/mcp")) baseUrl = baseUrl.slice(0, -"/mcp".length)

    const apiKey = String(res?.[MCP_RUNTIME_API_KEY_STORAGE] || res?.[RUNTIME_API_KEY_STORAGE] || "")
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

  async function mcpFetch(path, opts) {
    const { baseUrl, apiKey } = await getMcpRuntimeConfig()
    if (!baseUrl) {
      throw new Error("LangChain agents MCP not configured. Set `/runtime url <your-mcp-url>`")
    }
    const url = `${baseUrl}${path}`
    const headers = { "content-type": "application/json" }
    if (apiKey) {
      // Support either x-glazyr-api-key or Authorization: Bearer <key>
      if (String(apiKey).toLowerCase().startsWith("bearer ")) headers["authorization"] = apiKey
      else headers["x-glazyr-api-key"] = apiKey
    }

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
      // Include more details from the error response
      let msg = typeof data?.error === "string" ? data.error : `Runtime request failed (${res.status})`
      if (data?.message) msg = String(data.message)
      if (data?.detail) msg = String(data.detail)
      // Include full error data for debugging
      const err = new Error(msg)
      err.status = res.status
      err.data = data
      err.fullResponse = text
      throw err
    }

    return { status: res.status, data }
  }

  function extractMcpResponseText(data) {
    if (data == null) return ""
    if (typeof data === "string") return data

    // LangChain agents MCP format: { content: [{ type: "text", text: "..." }] }
    if (Array.isArray(data?.content)) {
      const textParts = []
      for (const item of data.content) {
        if (item?.type === "text" && typeof item.text === "string") {
          textParts.push(item.text)
        } else if (typeof item === "string") {
          textParts.push(item)
        }
      }
      if (textParts.length > 0) return textParts.join("\n\n")
    }

    // Common shapes: { output: "..." }, { result: { output: "..." } }, { message: "..." }
    const candidates = [
      data?.output,
      data?.text,
      data?.message,
      data?.result?.output,
      data?.result?.text,
      data?.result?.message,
    ]
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return c
    }

    try {
      const s = JSON.stringify(data, null, 2)
      return s
    } catch {
      return String(data)
    }
  }

  async function mcpGetManifest() {
    return await mcpFetch("/mcp/manifest", { method: "GET" })
  }

  async function mcpInvokeAgentExecutor(input, taskId, toolName) {
    // Default to "agent_executor" (LangChain agents MCP standard tool name)
    // But allow override for other MCP servers
    const tool = String(toolName || "agent_executor")
    
    // LangChain agents MCP expects "arguments" with "query" field (not "input")
    return await mcpFetch("/mcp/invoke", {
      method: "POST",
      body: {
        tool: tool,
        arguments: {
          query: String(input || ""),
        },
      },
    })
  }

  async function mcpGetTask(taskId) {
    const id = encodeURIComponent(String(taskId || ""))
    return await mcpFetch(`/api/tasks/${id}`, { method: "GET" })
  }

  async function runtimeFetchFirstOk(paths, opts) {
    const tried = []
    let lastErr = null
    for (const p of paths) {
      try {
        tried.push(String(p))
        const res = await runtimeFetch(String(p), opts)
        return { ...res, _triedPaths: tried }
      } catch (e) {
        lastErr = e
      }
    }
    const err = new Error(String(lastErr?.message || lastErr || "All runtime endpoints failed."))
    err.triedPaths = tried
    throw err
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

  // Legacy orchestrator polling (deprecated). Keep opt-in so MCP-only runtimes don't get spammed.
  async function isLegacyOrchestratorEnabled() {
    const res = await storageGet([LEGACY_ORCHESTRATOR_ENABLED_STORAGE])
    return !!res?.[LEGACY_ORCHESTRATOR_ENABLED_STORAGE]
  }

  setInterval(() => {
    isLegacyOrchestratorEnabled()
      .then((enabled) => {
        if (!enabled) return
        return pollRuntimeOnce().catch(() => {})
      })
      .catch(() => {})
  }, 1500)

  // MCP task polling (for widget status)
  let activeMcpTaskId = ""
  let mcpTaskPollTimer = null

  function stopMcpTaskPolling() {
    if (mcpTaskPollTimer) clearInterval(mcpTaskPollTimer)
    mcpTaskPollTimer = null
    activeMcpTaskId = ""
  }

  function looksTerminalStatus(status) {
    const s = String(status || "").toLowerCase()
    return (
      s === "completed" ||
      s === "complete" ||
      s === "done" ||
      s === "failed" ||
      s === "error" ||
      s === "cancelled" ||
      s === "canceled"
    )
  }

  function startMcpTaskPolling(taskId) {
    const id = String(taskId || "").trim()
    if (!id) return
    activeMcpTaskId = id
    if (mcpTaskPollTimer) clearInterval(mcpTaskPollTimer)

      mcpTaskPollTimer = setInterval(() => {
        if (!activeMcpTaskId) return
        mcpGetTask(activeMcpTaskId)
          .then((res) => {
            const d = res?.data || {}
            const status = d?.status || d?.state || d?.phase || ""
            const summary =
              d?.summary || d?.title || d?.preview || d?.result?.summary || d?.result?.output || d?.output || ""

            safeRuntimeSendMessage({
              type: "RUNTIME_TASK_STATUS",
              taskId: activeMcpTaskId,
              status: String(status || ""),
              summary: typeof summary === "string" ? summary : "",
            })

            if (looksTerminalStatus(status)) stopMcpTaskPolling()
          })
          .catch((err) => {
            // If 404, the task endpoint doesn't exist (LangChain agents MCP might not support it)
            // Just stop polling silently instead of showing errors
            if (err?.status === 404) {
              stopMcpTaskPolling()
              return
            }
            // For other errors, show them but stop polling to avoid spam
            safeRuntimeSendMessage({
              type: "RUNTIME_TASK_STATUS",
              taskId: activeMcpTaskId,
              status: "error",
              summary: String(err?.message || err),
            })
            stopMcpTaskPolling()
          })
    }, 1500)
  }

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

    console.log("Starting Whisper transcription, audio size:", bytes, "bytes, mimeType:", normalizedType)

    // Add timeout to prevent hanging
    const timeoutMs = 60000 // 60 seconds
    const controller = new AbortController()
    const timeoutId = setTimeout(() => {
      controller.abort()
    }, timeoutMs)

    try {
      const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: form,
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      console.log("Whisper API response status:", resp.status, resp.statusText)

      const text = await resp.text()
      if (!resp.ok) {
        console.error("Whisper API error response:", text)
        throw new Error(`Whisper STT failed (${resp.status}): ${text}`)
      }

      const json = JSON.parse(text)
      const transcript = String(json?.text || "")
      console.log("Whisper transcription successful, length:", transcript.length)
      return transcript
    } catch (err) {
      clearTimeout(timeoutId)
      if (err.name === "AbortError") {
        console.error("Whisper transcription timed out after", timeoutMs, "ms")
        throw new Error(`Transcription timed out after ${timeoutMs / 1000} seconds. Please try again.`)
      }
      if (err.message) {
        throw err
      }
      console.error("Whisper transcription error:", err)
      throw new Error(`Transcription failed: ${String(err)}`)
    }
  }

  async function ensureOffscreenDocument() {
    if (!chrome?.offscreen?.createDocument) throw new Error("Offscreen API not available.")
    const has = chrome.offscreen.hasDocument ? await chrome.offscreen.hasDocument() : false
    if (has) return
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA", "BLOBS"],
      justification: "Record microphone audio (Whisper STT) and stitch full-page screenshots in an offscreen document.",
    })
  }

  function runtimeSendMessageAsync(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          const err = chrome.runtime.lastError
          if (err) return reject(new Error(err.message))
          resolve(res)
        })
      } catch (e) {
        reject(e)
      }
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

  async function fetchImageUrlToDataUrl(imageUrl) {
    const url = String(imageUrl || "").trim()
    if (!url) throw new Error("Missing imageUrl.")
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Failed to fetch image (${res.status}).`)
    const blob = await res.blob()
    return await blobToDataUrl(blob)
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

  function formatLabelList(labels) {
    const arr = Array.isArray(labels)
      ? labels
      : typeof labels === "string"
        ? labels.split(",").map((s) => s.trim()).filter(Boolean)
        : []
    const seen = new Set()
    const out = []
    for (const l of arr) {
      const name = String(typeof l === "string" ? l : l?.description || l?.name || "").trim()
      if (!name) continue
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(name)
      if (out.length >= 24) break
    }
    return out.length ? out.join(", ") : ""
  }

  function formatObjectList(objects) {
    const arr = Array.isArray(objects)
      ? objects
      : typeof objects === "string"
        ? objects.split(",").map((s) => s.trim()).filter(Boolean)
        : []
    const seen = new Set()
    const out = []
    for (const o of arr) {
      const name = String(typeof o === "string" ? o : o?.name || o?.description || "").trim()
      if (!name) continue
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(name)
      if (out.length >= 24) break
    }
    return out.length ? out.join(", ") : ""
  }

  async function analyzeImageWithRuntimeAnalyze(imageDataUrl, features) {
    // Runtime now supports a single endpoint that returns OCR + caption + labels + objects.
    // Some deployments mount the same handler at different base paths; try a few common ones.
    const res = await runtimeFetchFirstOk(
      ["/runtime/vision/analyze", "/vision/analyze", "/api/vision/analyze", "/api/runtime/vision/analyze"],
      {
        method: "POST",
        body: { imageDataUrl, features: features || undefined },
      }
    )
    const data = res?.data || {}
    if (typeof data === "string") {
      return { text: "", caption: data, labels: [], objects: [], raw: data }
    }

    const text = typeof data.text === "string" ? data.text : ""
    const caption = typeof data.caption === "string" ? data.caption : ""

    const labels =
      Array.isArray(data.labels) ? data.labels : Array.isArray(data.labelAnnotations) ? data.labelAnnotations : []
    const objects =
      Array.isArray(data.objects)
        ? data.objects
        : Array.isArray(data.localizedObjectAnnotations)
          ? data.localizedObjectAnnotations
          : []

    return { text, caption, labels, objects, raw: data }
  }

  async function analyzeImageCombined(imageDataUrl) {
    // Vision-first: always prefer single-call analyze endpoint (caption/labels/objects + OCR if available).
    // Only include OCR text when Vision actually returns text (no "OCR: No text detected." spam).
    // Fallback: OCR-only endpoint.
    try {
      const r = await analyzeImageWithRuntimeAnalyze(imageDataUrl, { ocr: true, labels: true, objects: true })
      const labelList = formatLabelList(r.labels)
      const objectList = formatObjectList(r.objects)

      // Caption is optional; hide it if it's blank or obviously a labels string to avoid duplication.
      let caption = String(r.caption || "").trim()
      if (caption) {
        const cLower = caption.toLowerCase()
        const looksLikeLabels = cLower.startsWith("labels:") || cLower.startsWith("label:")
        const duplicatesLabels = !!labelList && cLower.includes(labelList.toLowerCase())
        if (looksLikeLabels || duplicatesLabels) caption = ""
      }

      const ocr = String(r.text || "").trim()

      // Sentence-style formatting so it remains readable even if the chat UI collapses newlines.
      const parts = []
      if (caption) parts.push(`Caption: ${caption.slice(0, 1600)}`)
      if (labelList) parts.push(`Labels: ${labelList}`)
      if (objectList) parts.push(`Objects: ${objectList}`)
      if (ocr) parts.push(`Text: ${ocr.slice(0, 8000)}`)

      if (!parts.length) return "No visual signals detected."
      return parts.join("\n")
    } catch (e) {
      // Fallback to OCR-only so capture still returns something even if analyze is down/not deployed.
      try {
        const ocrText = String(await analyzeImageWithRuntimeOcr(imageDataUrl))
        const ocrTrimmed = String(ocrText || "").trim()
        const base = ocrTrimmed ? `Text:\n${ocrTrimmed.slice(0, 8000)}` : "No text detected."
        const tried = Array.isArray(e?.triedPaths) ? e.triedPaths.join(", ") : "/runtime/vision/analyze"
        return (
          base +
          "\n\n" +
          `Note: Vision analyze endpoint unavailable, showing OCR-only.\n` +
          `Tried: ${tried}\n` +
          `Details: ${String(e?.message || e).slice(0, 300)}`
        )
      } catch (e2) {
        return `Vision/OCR error: ${String(e2?.message || e?.message || e2 || e)}`
      }
    }
  }

  function normalizeWhitespace(s) {
    return String(s || "")
      .replace(/\s+/g, " ")
      .trim()
  }

  function parseVisionAnalysisText(raw) {
    const s = String(raw || "").trim()
    if (!s) return { raw: "", caption: "", labels: "", objects: "", text: "" }

    const lines = s.split(/\r?\n/)
    let caption = ""
    let labels = ""
    let objects = ""
    let collectingText = false
    const textLines = []

    for (const line of lines) {
      const t = String(line || "").trim()
      const lower = t.toLowerCase()

      if (lower.startsWith("caption:")) {
        caption = t.slice("caption:".length).trim()
        collectingText = false
        continue
      }
      if (lower.startsWith("labels:")) {
        labels = t.slice("labels:".length).trim()
        collectingText = false
        continue
      }
      if (lower.startsWith("objects:")) {
        objects = t.slice("objects:".length).trim()
        collectingText = false
        continue
      }
      if (lower.startsWith("text:")) {
        collectingText = true
        const after = t.slice("text:".length).trim()
        if (after) textLines.push(after)
        continue
      }

      if (collectingText) {
        // Don't slurp metadata from OCR-only fallback format.
        if (lower.startsWith("note:") || lower.startsWith("tried:") || lower.startsWith("details:")) {
          collectingText = false
          continue
        }
        textLines.push(line)
      }
    }

    const text = textLines.join("\n").trim()
    return { raw: s, caption, labels, objects, text }
  }

  function formatVisionAnalysisForUser(raw) {
    const p = parseVisionAnalysisText(raw)
    const looksStructured = !!(p.caption || p.labels || p.objects || p.text)

    if (!looksStructured) {
      const compact = normalizeWhitespace(p.raw)
      const q = compact.length > 240 ? compact.slice(0, 240) + "…" : compact
      return `Quoted text: "${q}"`
    }

    const quoteSource = p.text ? normalizeWhitespace(p.text) : normalizeWhitespace(p.caption)
    const quoted = quoteSource
      ? quoteSource.length > 240
        ? quoteSource.slice(0, 240) + "…"
        : quoteSource
      : "(none detected)"

    let summary = ""
    if (p.caption) {
      summary = String(p.caption || "").trim()
    } else if (p.text) {
      const compact = normalizeWhitespace(p.text)
      const m = compact.match(/^[\s\S]{1,600}?[.?!](\s|$)/)
      const firstSentence = (m ? m[0] : compact).trim()
      summary = firstSentence.length > 240 ? firstSentence.slice(0, 240) + "…" : firstSentence
    }

    summary = String(summary || "").trim()
    if (summary.length > 900) summary = summary.slice(0, 900) + "…"

    return `Quoted text: "${quoted}"\nSummary: ${summary || "(no summary)"}`
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

    // Analyze (OCR + optional vision analysis) and report back to popup and page.
    const analysisText = await analyzeImageCombined(croppedDataUrl)
    await chrome.storage.local.set({
      lastCapture: { imageDataUrl: croppedDataUrl, analysisText, ts: Date.now() },
    })

    safeRuntimeSendMessage({ type: "ANALYSIS_RESULT", text: analysisText, imageDataUrl: croppedDataUrl })
    chrome.tabs.sendMessage(tabId, { type: "AI_RESPONSE", text: formatVisionAnalysisForUser(analysisText) }, () => {
      void chrome.runtime.lastError
    })
  }

  const fullPageSessions = new Map()

  async function captureVisibleTabDataUrl(windowId, options) {
    return await new Promise((resolve, reject) => {
      chrome.tabs.captureVisibleTab(windowId, options, (dataUrl) => {
        const err = chrome.runtime.lastError
        if (err) return reject(new Error(err.message))
        if (!dataUrl) return reject(new Error("No screenshot data returned."))
        resolve(dataUrl)
      })
    })
  }

  async function handleFullPageInit(sender, payload) {
    await checkPolicyOrThrow(sender, "screenshot")
    const tabId = sender?.tab?.id
    const windowId = sender?.tab?.windowId
    if (!tabId || typeof windowId !== "number") throw new Error("No active tab/window for capture.")

    const meta = payload?.meta || {}
    const fullHeightCss = Number(meta.fullHeightCss || 0)
    const viewportWidthCss = Number(meta.viewportWidthCss || 0)
    const viewportHeightCss = Number(meta.viewportHeightCss || 0)
    if (!fullHeightCss || !viewportWidthCss || !viewportHeightCss) throw new Error("Invalid capture metadata.")

    const sessionId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    fullPageSessions.set(sessionId, { tabId, windowId, meta: { fullHeightCss, viewportWidthCss, viewportHeightCss } })

    safeRuntimeSendMessage({ type: "CAPTURE_STARTED" })
    safeRuntimeSendMessage({ type: "CAPTURE_HINT", text: "Capturing full page… (scrolling briefly)" })

    await ensureOffscreenDocument()
    await runtimeSendMessageAsync({
      type: "OFFSCREEN_STITCH_BEGIN",
      sessionId,
      meta: { fullHeightCss, viewportWidthCss, viewportHeightCss },
    })

    return { ok: true, sessionId }
  }

  async function handleFullPageGrab(sender, payload) {
    await checkPolicyOrThrow(sender, "screenshot")
    const tabId = sender?.tab?.id
    const sessionId = String(payload?.sessionId || "")
    const sess = fullPageSessions.get(sessionId)
    if (!sessionId || !sess) throw new Error("No active full-page capture session.")
    if (tabId && sess.tabId && tabId !== sess.tabId) throw new Error("Session/tab mismatch.")

    const scrollYCss = Number(payload?.scrollYCss || 0)
    const index = Number(payload?.index || 0)
    const total = Number(payload?.total || 0)

    if (Number.isFinite(index) && Number.isFinite(total) && total > 0) {
      safeRuntimeSendMessage({ type: "CAPTURE_HINT", text: `Capturing full page… ${index + 1}/${total}` })
    }

    const dataUrl = await captureVisibleTabDataUrl(sess.windowId, { format: "jpeg", quality: 92 })

    await runtimeSendMessageAsync({
      type: "OFFSCREEN_STITCH_APPEND",
      sessionId,
      dataUrl,
      scrollYCss,
    })

    return { ok: true }
  }

  async function handleFullPageComplete(sender, payload) {
    await checkPolicyOrThrow(sender, "screenshot")
    const tabId = sender?.tab?.id
    const sessionId = String(payload?.sessionId || "")
    const sess = fullPageSessions.get(sessionId)
    if (!sessionId || !sess) throw new Error("No active full-page capture session.")
    if (tabId && sess.tabId && tabId !== sess.tabId) throw new Error("Session/tab mismatch.")

    const stitched = await runtimeSendMessageAsync({
      type: "OFFSCREEN_STITCH_FINISH",
      sessionId,
      output: { type: "image/jpeg", quality: 0.92 },
    })
    const imageDataUrl = String(stitched?.dataUrl || "")
    if (!imageDataUrl) throw new Error("Stitching returned no image.")

    fullPageSessions.delete(sessionId)

    safeRuntimeSendMessage({ type: "CAPTURE_DONE", imageDataUrl })

    // Analyze (OCR + optional vision analysis). If the vision endpoint isn't available yet,
    // this gracefully falls back to OCR-only.
    const analysisText = await analyzeImageCombined(imageDataUrl)

    await chrome.storage.local.set({
      lastCapture: { imageDataUrl, analysisText, ts: Date.now() },
    })

    safeRuntimeSendMessage({ type: "ANALYSIS_RESULT", text: analysisText, imageDataUrl })
    if (sess.tabId) {
      chrome.tabs.sendMessage(
        sess.tabId,
        { type: "AI_RESPONSE", text: formatVisionAnalysisForUser(analysisText) },
        () => void chrome.runtime.lastError
      )
    }

    return { ok: true }
  }

  async function handleFullPageAbort(_sender, payload) {
    const sessionId = String(payload?.sessionId || "")
    if (sessionId) fullPageSessions.delete(sessionId)
    try {
      if (sessionId) await runtimeSendMessageAsync({ type: "OFFSCREEN_STITCH_ABORT", sessionId })
    } catch {}
    safeRuntimeSendMessage({ type: "ANALYSIS_ERROR", text: String(payload?.error || "Full page capture aborted.") })
    return { ok: true }
  }

  // Helper to request fresh page context from content script
  async function requestFreshPageContext(tabId) {
    return new Promise((resolve) => {
      // Inject a small script to capture fresh context with delay
      if (chrome?.scripting?.executeScript) {
        chrome.scripting.executeScript(
          {
            target: { tabId },
            func: () => {
              // Wait a bit for page to stabilize, then capture context
              setTimeout(() => {
                const url = window.location.href
                const title = document.title
                const text = document.body ? document.body.innerText.substring(0, 5000) : ""
                chrome.runtime.sendMessage(
                  { type: "PAGE_CONTEXT", url, title, text },
                  () => void chrome.runtime.lastError
                )
              }, 1500)
            },
          },
          () => {
            // Give it time to execute
            setTimeout(resolve, 2000)
          }
        )
      } else {
        // Fallback: just send a message
        chrome.tabs.sendMessage(tabId, { type: "REQUEST_PAGE_CONTEXT" }, () => {
          setTimeout(resolve, 2000)
        })
      }
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
      ;(async () => {
        try {
          await checkPolicyOrThrow(sender, "screenshot")
          safeRuntimeSendMessage({ type: "CAPTURE_STARTED" })

          const imageDataUrl = msg?.dataUrl
            ? String(msg.dataUrl || "")
            : msg?.imageUrl
              ? await fetchImageUrlToDataUrl(msg.imageUrl)
              : ""
          if (!imageDataUrl) throw new Error("No image provided for analysis.")

          safeRuntimeSendMessage({ type: "CAPTURE_DONE", imageDataUrl })
          safeRuntimeSendMessage({ type: "CAPTURE_HINT", text: "Analyzing image…" })

          const analysisText = await analyzeImageCombined(imageDataUrl)

          await chrome.storage.local.set({
            lastCapture: { imageDataUrl, analysisText, ts: Date.now() },
          })

          safeRuntimeSendMessage({ type: "ANALYSIS_RESULT", text: analysisText, imageDataUrl })
          if (sender?.tab?.id) {
            chrome.tabs.sendMessage(
              sender.tab.id,
              { type: "AI_RESPONSE", text: formatVisionAnalysisForUser(analysisText) },
              () => void chrome.runtime.lastError
            )
          }
          sendResponse({ status: "ok" })
        } catch (err) {
          const text = String(err?.message || err)
          safeRuntimeSendMessage({ type: "ANALYSIS_ERROR", text })
          sendResponse({ status: "error", error: text })
        }
      })()
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

    // Full page capture (scroll in content script, capture+stitch here/offscreen)
    if (msg?.type === "FULLPAGE_CAPTURE_INIT") {
      handleFullPageInit(sender, msg).then(
        (res) => sendResponse(res),
        (err) => sendResponse({ ok: false, error: String(err?.message || err) })
      )
      return true
    }

    if (msg?.type === "FULLPAGE_CAPTURE_GRAB") {
      handleFullPageGrab(sender, msg).then(
        (res) => sendResponse(res),
        (err) => sendResponse({ ok: false, error: String(err?.message || err) })
      )
      return true
    }

    if (msg?.type === "FULLPAGE_CAPTURE_COMPLETE") {
      handleFullPageComplete(sender, msg).then(
        (res) => sendResponse(res),
        (err) => {
          console.error("Full page stitch failed:", err)
          sendResponse({ ok: false, error: String(err?.message || err) })
          safeRuntimeSendMessage({ type: "ANALYSIS_ERROR", text: String(err?.message || err) })
        }
      )
      return true
    }

    if (msg?.type === "FULLPAGE_CAPTURE_ABORT") {
      handleFullPageAbort(sender, msg).then(
        (res) => sendResponse(res),
        () => sendResponse({ ok: true })
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
              const errorMsg = chrome.runtime.lastError.message
              console.error("STT_RECORD_START error:", errorMsg)
              safeRuntimeSendMessage({ type: "STT_ERROR", text: errorMsg })
              sendResponse({ ok: false, error: errorMsg })
              return
            }
            if (!res?.ok) {
              const errorMsg = res?.error || "Failed to start recording."
              console.error("STT_RECORD_START failed:", errorMsg)
              safeRuntimeSendMessage({ type: "STT_ERROR", text: errorMsg })
              sendResponse({ ok: false, error: errorMsg })
              return
            }
            safeRuntimeSendMessage({ type: "STT_STATUS", text: "Recording… click mic to stop." })
            sendResponse({ ok: true })
          })
        })
        .catch((e) => {
          const errorMsg = String(e?.message || e)
          console.error("STT_RECORD_START exception:", errorMsg, e)
          safeRuntimeSendMessage({ type: "STT_ERROR", text: errorMsg })
          sendResponse({ ok: false, error: errorMsg })
        })
      return true
    }

    if (msg?.type === "STT_RECORD_STOP") {
      ensureOffscreenDocument()
        .then(() => {
          safeRuntimeSendMessage({ type: "STT_STATUS", text: "Stopping…" })
          chrome.runtime.sendMessage({ type: "OFFSCREEN_RECORD_STOP" }, (res) => {
            if (chrome.runtime.lastError) {
              const errorMsg = chrome.runtime.lastError.message
              console.error("STT_RECORD_STOP error:", errorMsg)
              safeRuntimeSendMessage({ type: "STT_ERROR", text: errorMsg })
              sendResponse({ ok: false, error: errorMsg })
              return
            }
            if (!res?.ok) {
              const errorMsg = res?.error || "Failed to stop recording."
              console.error("STT_RECORD_STOP failed:", errorMsg)
              safeRuntimeSendMessage({ type: "STT_ERROR", text: errorMsg })
              sendResponse({ ok: false, error: errorMsg })
              return
            }
            safeRuntimeSendMessage({ type: "STT_STATUS", text: "Transcribing…" })
            sendResponse({ ok: true })
          })
        })
        .catch((e) => {
          const errorMsg = String(e?.message || e)
          console.error("STT_RECORD_STOP exception:", errorMsg, e)
          safeRuntimeSendMessage({ type: "STT_ERROR", text: errorMsg })
          sendResponse({ ok: false, error: errorMsg })
        })
      return true
    }

    if (msg?.type === "OFFSCREEN_AUDIO_READY") {
      // Back-compat: older offscreen recorders sent `audio` (ArrayBuffer) instead of `audioBytes` (Uint8Array)
      const audioPayload = msg.audioBytes ?? msg.audio
      
      // Validate audio payload before transcription
      if (!audioPayload) {
        const errorMsg = "No audio data received from recorder. Please try recording again."
        console.error("OFFSCREEN_AUDIO_READY: No audio payload", msg)
        safeRuntimeSendMessage({ type: "STT_ERROR", text: errorMsg })
        sendResponse?.({ ok: false, error: errorMsg })
        return true
      }
      
      // When passed through chrome.runtime.sendMessage, Uint8Array gets serialized to a plain object
      // We need to reconstruct it. Check if it's already a typed array or needs conversion
      let audioBytes = audioPayload
      let audioSize = 0
      
      if (audioPayload instanceof Uint8Array) {
        audioSize = audioPayload.length
        audioBytes = audioPayload
      } else if (audioPayload instanceof ArrayBuffer) {
        audioSize = audioPayload.byteLength
        audioBytes = new Uint8Array(audioPayload)
      } else if (ArrayBuffer.isView(audioPayload)) {
        audioSize = audioPayload.byteLength || audioPayload.length
        audioBytes = new Uint8Array(audioPayload.buffer || audioPayload)
      } else {
        // It's been serialized - reconstruct from object
        // Check if it has numeric keys (serialized array)
        const keys = Object.keys(audioPayload).filter(k => !isNaN(parseInt(k)))
        audioSize = keys.length
        
        if (audioSize > 0) {
          // Reconstruct Uint8Array from serialized object
          const arr = new Uint8Array(audioSize)
          for (let i = 0; i < audioSize; i++) {
            arr[i] = audioPayload[i] || 0
          }
          audioBytes = arr
          console.log("OFFSCREEN_AUDIO_READY: Reconstructed Uint8Array from serialized object, size:", audioSize)
        }
      }
      
      console.log("OFFSCREEN_AUDIO_READY: Audio payload type:", audioPayload.constructor?.name || typeof audioPayload, "size:", audioSize, "bytes")
      
      if (audioSize === 0) {
        const errorMsg = "Recorded audio was empty. Please record for at least 1-2 seconds and try again."
        console.error("OFFSCREEN_AUDIO_READY: Empty audio payload", audioPayload)
        safeRuntimeSendMessage({ type: "STT_ERROR", text: errorMsg })
        sendResponse?.({ ok: false, error: errorMsg })
        return true
      }
      
      console.log("Starting transcription, audio size:", audioSize, "bytes, mimeType:", msg.mimeType)
      
      transcribeWhisper({ audioBytes: audioBytes, mimeType: msg.mimeType })
        .then(
          (text) => {
            console.log("Transcription completed successfully")
            safeRuntimeSendMessage({ type: "STT_RESULT", text })
          },
          (err) => {
            const errorMsg = String(err?.message || err)
            console.error("STT transcription error:", errorMsg, err)
            safeRuntimeSendMessage({ type: "STT_ERROR", text: errorMsg })
          }
        )
        .catch((err) => {
          // Catch any unexpected errors
          const errorMsg = String(err?.message || err || "Unexpected transcription error")
          console.error("STT transcription unexpected error:", errorMsg, err)
          safeRuntimeSendMessage({ type: "STT_ERROR", text: errorMsg })
        })
      sendResponse?.({ ok: true })
      return true
    }

    if (msg?.type === "USER_QUERY") {
      const query = String(msg.query || "")
      const q = query.toLowerCase()
      const rawTrimmed = String(query || "").trim()

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

      function slashHelp() {
        return (
          "Slash commands:\n" +
          "- /help\n" +
          "- /mcp <message>   (force call the LangChain agents MCP)\n" +
          "- /mcp/manifest   (show available MCP tools)\n" +
          "- /runtime url <baseUrl>\n" +
          "- /runtime key <key>   (or: /runtime key Bearer <key>)\n" +
          "- /runtime show\n"
        )
      }

      async function invokeMcpNow(userMessage) {
        const taskId = crypto.randomUUID()

        // Request fresh page context with a delay to let the page finish loading
        // Flash the extension icon and logo to show we're waiting
        let ctx = contextBuffer[0] || {}
        if (sender?.tab?.id) {
          try {
            chrome.action.setBadgeText({ tabId: sender.tab.id, text: "⏳" })
            chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: "#2196F3" })
          } catch {}

          // Notify popup to flash the logo
          safeRuntimeSendMessage({ type: "PAGE_CONTEXT_LOADING" })

          // Request fresh context with delay (waits for page to stabilize)
          await requestFreshPageContext(sender.tab.id)

          // Refresh context from buffer (might have updated)
          const freshCtx = contextBuffer[0] || ctx
          if (freshCtx) ctx = freshCtx

          // Clear the badge and stop flashing
          try {
            chrome.action.setBadgeText({ tabId: sender.tab.id, text: "" })
          } catch {}
          safeRuntimeSendMessage({ type: "PAGE_CONTEXT_LOADED" })
        }

        const lastCapture = await storageGet(["lastCapture"]).then((r) => r?.lastCapture || null)
        const derivedVision = String(lastCapture?.analysisText || "").trim()
        const pageSnippet = String(ctx?.text || "").trim().slice(0, 1400)

        const input =
          `User: ${String(userMessage || "").trim()}\n\n` +
          `Context:\n` +
          (ctx?.url ? `- URL: ${String(ctx.url)}\n` : "") +
          (ctx?.title ? `- Title: ${String(ctx.title)}\n` : "") +
          (pageSnippet ? `- Page excerpt: ${pageSnippet}${pageSnippet.length >= 1400 ? "…" : ""}\n` : "") +
          (derivedVision ? `\nVision/OCR (derived text only):\n${derivedVision.slice(0, 8000)}\n` : "")

        // Try calling with the standard format first
        try {
          const res = await mcpInvokeAgentExecutor(input, taskId)
          // Start task polling (will gracefully stop if endpoint doesn't exist)
          startMcpTaskPolling(taskId)
          const text = extractMcpResponseText(res?.data).trim()
          if (text) return { text: text.slice(0, 8000), taskId }
          return { text: `Queued in runtime.\nTask: ${taskId}`, taskId }
        } catch (e) {
          // Re-throw with better error details
          throw e
        }
      }

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

      // Lightweight runtime configuration via chat (so we don't need a settings UI yet).
      // Examples:
      // - "set runtime url https://..."
      // - "set runtime key Bearer ..."
      // - "show runtime config"
      if (nq.startsWith("set runtime url ")) {
        const url = String(query).slice(String("set runtime url ").length).trim().replace(/\/+$/, "")
        chrome.storage.local.set({ [MCP_RUNTIME_BASE_URL_STORAGE]: url }, () => {
          sendResponse({ type: "AI_RESPONSE", text: url ? `Runtime URL set.` : "Runtime URL cleared." })
        })
        return true
      }

      if (nq.startsWith("set runtime key ")) {
        const key = String(query).slice(String("set runtime key ").length).trim()
        chrome.storage.local.set({ [MCP_RUNTIME_API_KEY_STORAGE]: key }, () => {
          sendResponse({ type: "AI_RESPONSE", text: key ? `Runtime key set.` : "Runtime key cleared." })
        })
        return true
      }

      if (nq === "show runtime config") {
        getMcpRuntimeConfig()
          .then((cfg) => {
            sendResponse({
              type: "AI_RESPONSE",
              text:
                `Runtime URL: ${String(cfg?.baseUrl || "(not set)")}\n` +
                `Auth: ${cfg?.apiKey ? "(set)" : "(not set)"}`,
            })
          })
          .catch((e) => sendResponse({ type: "AI_RESPONSE", text: String(e?.message || e) }))
        return true
      }

      // Slash commands (power user / debug)
      if (rawTrimmed.startsWith("/")) {
        // Handle /mcp/manifest specially (it has a slash, not a space)
        if (rawTrimmed.toLowerCase().startsWith("/mcp/manifest")) {
          mcpGetManifest()
            .then((res) => {
              const manifest = res?.data || {}
              const tools = manifest?.tools || []
              const toolList =
                tools.length > 0
                  ? tools.map((t) => `- ${String(t.name || "")}: ${String(t.description || "No description")}`).join("\n")
                  : "No tools found in manifest."
              sendResponse({
                type: "AI_RESPONSE",
                text: `LangChain agents MCP Manifest:\n\nAvailable tools (${tools.length}):\n${toolList}`,
              })
            })
            .catch((e) => {
              const errMsg = String(e?.message || e)
              sendResponse({ type: "AI_RESPONSE", text: `Failed to fetch manifest: ${errMsg}` })
            })
          return true
        }

        const parts = rawTrimmed.split(/\s+/)
        const cmd = String(parts[0] || "").toLowerCase()
        const rest = rawTrimmed.slice(parts[0].length).trim()

        if (cmd === "/help") {
          sendResponse({ type: "AI_RESPONSE", text: slashHelp() })
          return true
        }

        // Handle /mcp commands (both /mcp/manifest and /mcp <message>)
        if (cmd === "/mcp" || cmd.startsWith("/mcp/")) {
          // Check if it's /mcp/manifest (either "/mcp/manifest" or "/mcp manifest")
          const isManifest =
            cmd === "/mcp/manifest" ||
            cmd.startsWith("/mcp/manifest") ||
            (cmd === "/mcp" && (parts[1]?.toLowerCase() === "manifest" || rest.toLowerCase().startsWith("manifest")))

          if (isManifest) {
            mcpGetManifest()
              .then((res) => {
                const manifest = res?.data || {}
                const tools = manifest?.tools || []
                const toolList =
                  tools.length > 0
                    ? tools
                        .map((t) => {
                          const name = String(t.name || "")
                          const desc = String(t.description || "No description")
                          const inputSchema = t.inputSchema ? JSON.stringify(t.inputSchema, null, 2) : "No schema"
                          return `${name}:\n  Description: ${desc}\n  Input schema: ${inputSchema}`
                        })
                        .join("\n\n")
                    : "No tools found in manifest."
                sendResponse({
                  type: "AI_RESPONSE",
                  text: `LangChain agents MCP Manifest:\n\nAvailable tools (${tools.length}):\n\n${toolList}`,
                })
              })
              .catch((e) => {
                const errMsg = String(e?.message || e)
                if (errMsg.includes("MCP runtime URL not configured")) {
                  sendResponse({
                    type: "AI_RESPONSE",
                    text:
                      `MCP runtime URL not configured.\n\n` +
                      `To use LangChain agents MCP:\n` +
                      `1) Set runtime URL: \`/runtime url https://<your-langchain-agents-mcp-base>\`\n` +
                      `2) (Optional) Set API key: \`/runtime key <key>\`\n` +
                      `3) Then try: \`/mcp/manifest\``,
                  })
                } else {
                  sendResponse({ type: "AI_RESPONSE", text: `Failed to fetch manifest: ${errMsg}` })
                }
              })
            return true
          }
          // Otherwise, invoke the agent
          const msgText = rest || "Hello"
          invokeMcpNow(msgText).then(
            (r) => sendResponse({ type: "AI_RESPONSE", text: r.text }),
            (e) => {
              const errMsg = String(e?.message || e)
              // Include more error details for 422 (validation errors)
              let errorText = errMsg
              if (e?.status === 422 && e?.data) {
                const details = typeof e.data === "object" ? JSON.stringify(e.data, null, 2) : String(e.data)
                errorText = `Validation error (422): ${errMsg}\n\nDetails: ${details.slice(0, 500)}`
              } else if (e?.fullResponse) {
                errorText = `${errMsg}\n\nResponse: ${String(e.fullResponse).slice(0, 500)}`
              }

              if (errMsg.includes("MCP runtime URL not configured")) {
                sendResponse({
                  type: "AI_RESPONSE",
                  text:
                    `MCP runtime URL not configured.\n\n` +
                    `To use LangChain agents MCP:\n` +
                    `1) Set runtime URL: \`/runtime url https://<your-langchain-agents-mcp-base>\`\n` +
                    `2) (Optional) Set API key: \`/runtime key <key>\`\n` +
                    `3) Then ask your question again: \`/mcp ${msgText}\``,
                })
              } else {
                sendResponse({ type: "AI_RESPONSE", text: errorText })
              }
            }
          )
          return true
        }

        if (cmd === "/assistant") {
          const msgText = rest || "Hello"
          invokeMcpNow(msgText).then(
            (r) => sendResponse({ type: "AI_RESPONSE", text: r.text }),
            (e) => sendResponse({ type: "AI_RESPONSE", text: String(e?.message || e) })
          )
          return true
        }

        if (cmd === "/runtime") {
          const sub = String(parts[1] || "").toLowerCase()
          const value = rawTrimmed.split(/\s+/).slice(2).join(" ").trim()

          if (sub === "url") {
            const url = String(value || "").trim().replace(/\/+$/, "")
            chrome.storage.local.set({ [MCP_RUNTIME_BASE_URL_STORAGE]: url }, () => {
              sendResponse({ type: "AI_RESPONSE", text: url ? "Runtime URL set." : "Runtime URL cleared." })
            })
            return true
          }

          if (sub === "key") {
            const key = String(value || "").trim()
            chrome.storage.local.set({ [MCP_RUNTIME_API_KEY_STORAGE]: key }, () => {
              sendResponse({ type: "AI_RESPONSE", text: key ? "Runtime key set." : "Runtime key cleared." })
            })
            return true
          }

          if (sub === "show") {
            getMcpRuntimeConfig()
              .then((cfg) => {
                sendResponse({
                  type: "AI_RESPONSE",
                  text:
                    `Runtime URL: ${String(cfg?.baseUrl || "(not set)")}\n` +
                    `Auth: ${cfg?.apiKey ? "(set)" : "(not set)"}`,
                })
              })
              .catch((e) => sendResponse({ type: "AI_RESPONSE", text: String(e?.message || e) }))
            return true
          }

          sendResponse({ type: "AI_RESPONSE", text: slashHelp() })
          return true
        }

        sendResponse({ type: "AI_RESPONSE", text: `Unknown command.\n\n${slashHelp()}` })
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
          // Use analyze endpoint first (Vision-backed OCR); only return text if present.
          analyzeImageWithRuntimeAnalyze(imageDataUrl, { ocr: true, labels: false, objects: false }).then(
            (r) => {
              const trimmed = String(r?.text || "").trim()
              sendResponse({ type: "AI_RESPONSE", text: trimmed ? trimmed.slice(0, 8000) : "No text detected." })
            },
            async (err) => {
              // Fallback to OCR-only endpoint.
              try {
                const text = await analyzeImageWithRuntimeOcr(imageDataUrl)
                const trimmed = String(text || "").trim()
                sendResponse({ type: "AI_RESPONSE", text: trimmed ? trimmed.slice(0, 8000) : "No text detected." })
              } catch (e2) {
                sendResponse({ type: "AI_RESPONSE", text: String(e2?.message || err?.message || e2 || err) })
              }
            }
          )
        })
        return true
      }

      let ctx = contextBuffer[0]
      
      // Request fresh page context with delay to let page finish loading
      // Flash the extension icon and logo to show we're waiting
      // Start refresh in background (non-blocking)
      if (sender?.tab?.id) {
        try {
          chrome.action.setBadgeText({ tabId: sender.tab.id, text: "⏳" })
          chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: "#2196F3" })
        } catch {}

        // Notify popup to flash the logo
        safeRuntimeSendMessage({ type: "PAGE_CONTEXT_LOADING" })

        // Request fresh context with delay (non-blocking, will update contextBuffer)
        requestFreshPageContext(sender.tab.id)
          .then(() => {
            // Refresh context from buffer after delay
            const freshCtx = contextBuffer[0]
            if (freshCtx) {
              // Clear the badge and stop flashing
              try {
                chrome.action.setBadgeText({ tabId: sender.tab.id, text: "" })
              } catch {}
              safeRuntimeSendMessage({ type: "PAGE_CONTEXT_LOADED" })
            }
          })
          .catch((err) => {
            console.error("Error refreshing page context:", err)
            // Clear the badge even on error
            try {
              chrome.action.setBadgeText({ tabId: sender.tab.id, text: "" })
            } catch {}
            safeRuntimeSendMessage({ type: "PAGE_CONTEXT_LOADED" })
          })
      }

      if (!ctx) {
        // If MCP is configured, try calling it anyway (it can work with minimal context).
        // Otherwise, show helpful guidance.
        getMcpRuntimeConfig()
          .then(async (cfg) => {
            if (cfg?.baseUrl) {
              // MCP is configured - call it with whatever context we have
              const lastCapture = await storageGet(["lastCapture"]).then((r) => r?.lastCapture || null)
              const derivedVision = String(lastCapture?.analysisText || "").trim()

              // Try to get current tab info as fallback context
              let tabUrl = ""
              let tabTitle = ""
              if (sender?.tab?.id) {
                try {
                  const tab = await new Promise((resolve) => {
                    chrome.tabs.get(sender.tab.id, (t) => {
                      if (chrome.runtime.lastError) resolve(null)
                      else resolve(t)
                    })
                  })
                  if (tab) {
                    tabUrl = String(tab.url || "")
                    tabTitle = String(tab.title || "")
                  }
                } catch {}
              }

              const input =
                `User: ${query}\n\n` +
                `Context:\n` +
                (tabUrl ? `- URL: ${tabUrl}\n` : "") +
                (tabTitle ? `- Title: ${tabTitle}\n` : "") +
                (derivedVision ? `\nVision/OCR (derived text only):\n${derivedVision.slice(0, 8000)}\n` : "")

              const taskId = crypto.randomUUID()
              const res = await mcpInvokeAgentExecutor(input, taskId)
              startMcpTaskPolling(taskId)

              const text = extractMcpResponseText(res?.data).trim()
              if (text) {
                sendResponse({ type: "AI_RESPONSE", text: text.slice(0, 8000) })
              } else {
                sendResponse({
                  type: "AI_RESPONSE",
                  text: `Queued in runtime.\nTask: ${taskId}`,
                })
              }
            } else {
              // MCP not configured - show helpful guidance
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
            }
          })
          .catch((e) => {
            // If getMcpRuntimeConfig fails (e.g., storage error), fall back to old behavior
            chrome.storage.local.get(["lastCapture"], (res) => {
              const last = res?.lastCapture
              const analysisText = String(last?.analysisText || "").trim()
          const guidance =
            "MCP runtime not configured.\n\n" +
            "To enable natural language responses:\n" +
            "1) Set runtime URL: `/runtime url https://<your-glazyr-control-base>`\n" +
            "2) (Optional) Set API key: `/runtime key <key>`\n" +
            "3) Ask your question again.\n\n" +
            "Tip: You can still use \"Framed shot\" for OCR on any page you can capture."

          if (analysisText) {
                const raw = analysisText.replace(/^OCR:\s*/i, "").trim()
                sendResponse({
                  type: "AI_RESPONSE",
                  text: `I don't have page context yet, but here's what I extracted from the last screenshot:\n\n${raw.slice(0, 1200)}\n\n${guidance}`,
                })
              } else {
                sendResponse({ type: "AI_RESPONSE", text: guidance })
              }
            })
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

      // Removed "summary" fallback - now goes through LangChain MCP

      // Removed "whats this page about" fallback - now goes through LangChain MCP
      if (false && (
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
      )) {
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
      // Removed - now goes through LangChain MCP

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
      Promise.resolve()
        .then(async () => {
          const taskId = crypto.randomUUID()

          // Request fresh page context with delay to let page finish loading
          // Flash the extension icon and logo to show we're waiting
          if (sender?.tab?.id) {
            try {
              chrome.action.setBadgeText({ tabId: sender.tab.id, text: "⏳" })
              chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: "#2196F3" })
            } catch {}

            // Notify popup to flash the logo
            safeRuntimeSendMessage({ type: "PAGE_CONTEXT_LOADING" })

            // Request fresh context with delay (waits for page to stabilize)
            await requestFreshPageContext(sender.tab.id)

            // Refresh context from buffer (might have updated)
            const freshCtx = contextBuffer[0] || ctx
            if (freshCtx && freshCtx !== ctx) {
              Object.assign(ctx, freshCtx)
            }

            // Clear the badge and stop flashing
            try {
              chrome.action.setBadgeText({ tabId: sender.tab.id, text: "" })
            } catch {}
            safeRuntimeSendMessage({ type: "PAGE_CONTEXT_LOADED" })
          }

          // Include derived vision/OCR if available (but do NOT send raw screenshots).
          const lastCapture = await storageGet(["lastCapture"]).then((r) => r?.lastCapture || null)
          const derivedVision = String(lastCapture?.analysisText || "").trim()

          const pageSnippet = String(ctx?.text || "").trim().slice(0, 1400)

          const input =
            `User: ${query}\n\n` +
            `Context:\n` +
            `- URL: ${String(ctx?.url || "")}\n` +
            `- Title: ${String(ctx?.title || "")}\n` +
            (pageSnippet ? `- Page excerpt: ${pageSnippet}${pageSnippet.length >= 1400 ? "…" : ""}\n` : "") +
            (derivedVision ? `\nVision/OCR (derived text only):\n${derivedVision.slice(0, 8000)}\n` : "")

          // Kick off task (MCP invoke)
          const res = await mcpInvokeAgentExecutor(input, taskId)
          startMcpTaskPolling(taskId)

          // Best-effort immediate response (if runtime returns output synchronously)
          const text = extractMcpResponseText(res?.data).trim()
          if (text) {
            sendResponse({ type: "AI_RESPONSE", text: text.slice(0, 8000) })
          } else {
            sendResponse({
              type: "AI_RESPONSE",
              text: `Queued in runtime.\nTask: ${taskId}`,
            })
          }
        })
        .catch((err) => {
          const errMsg = String(err?.message || err)
          // If MCP isn't configured, provide a helpful fallback response
          if (errMsg.includes("MCP runtime URL not configured")) {
            const pageInfo = ctx?.title ? `This page ("${ctx.title}")` : "This page"
            const snippet = String(ctx?.text || "").trim().slice(0, 400)
            const fallback =
              `${pageInfo} appears to be a web page. ` +
              (snippet
                ? `Here's a snippet of what I can see:\n\n${snippet}${snippet.length >= 400 ? "…" : ""}\n\n`
                : "") +
              `For more advanced AI responses, configure the MCP runtime:\n` +
              `- \`/runtime url https://<your-glazyr-control-base>\`\n` +
              `- (Optional) \`/runtime key <key>\``
            sendResponse({ type: "AI_RESPONSE", text: fallback })
          } else {
            sendResponse({ type: "AI_RESPONSE", text: errMsg })
          }
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