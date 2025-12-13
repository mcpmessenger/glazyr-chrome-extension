(() => {
  // Capture UI is now status-only (no screenshot preview, OCR prints into chat).
  // Keep storage keys for backwards compatibility, but we no longer use them.
  const CAPTURE_HEIGHT_STORAGE_KEY = "glazyrCapturePanelHeightPx"
  const CAPTURE_EXPANDED_HEIGHT_STORAGE_KEY = "glazyrCapturePanelExpandedHeightPx"
  const CAPTURE_COLLAPSED_HEIGHT_PX = 98

  function isRestrictedUrl(url) {
    const u = String(url || "")
    return (
      u.startsWith("chrome://") ||
      u.startsWith("chrome-extension://") ||
      u.startsWith("edge://") ||
      u.startsWith("about:") ||
      u.startsWith("view-source:") ||
      u.startsWith("devtools://") ||
      u.startsWith("chrome.google.com/webstore")
    )
  }

  function ensureRegionSelectContentScript(tabId, cb) {
    // If the content script listener isn't present (common after updates),
    // inject the file and retry.
    if (!chrome?.scripting?.executeScript) return cb?.()
    chrome.scripting.executeScript(
      { target: { tabId }, files: ["region_select_content.js"] },
      () => cb?.()
    )
  }

  function startFramedScreenshot() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs?.[0]?.id
      if (!tabId) return
      const url = tabs?.[0]?.url
      if (isRestrictedUrl(url)) {
        setStatus("Can’t capture on chrome:// or other restricted pages. Open a normal website tab.")
        return
      }
      setStatus("Select an area on the page: drag to frame, release to capture (Esc cancels).")
      chrome.tabs.sendMessage(tabId, { type: "BEGIN_REGION_SELECT" }, () => {
        const err = chrome.runtime.lastError
        if (!err) return
        // Retry after injecting the selection script
        ensureRegionSelectContentScript(tabId, () => {
          chrome.tabs.sendMessage(tabId, { type: "BEGIN_REGION_SELECT" }, () => {
            void chrome.runtime.lastError
          })
        })
      })
    })
  }

  function el(id) {
    return document.getElementById(id)
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n))
  }

  function getSavedCaptureHeight() {
    try {
      const v = localStorage.getItem(CAPTURE_HEIGHT_STORAGE_KEY)
      const n = v ? Number(v) : NaN
      return Number.isFinite(n) ? n : null
    } catch {
      return null
    }
  }

  function setSavedCaptureHeight(px) {
    try {
      localStorage.setItem(CAPTURE_HEIGHT_STORAGE_KEY, String(px))
    } catch {}
  }

  function getSavedExpandedCaptureHeight() {
    try {
      const v = localStorage.getItem(CAPTURE_EXPANDED_HEIGHT_STORAGE_KEY)
      const n = v ? Number(v) : NaN
      return Number.isFinite(n) ? n : null
    } catch {
      return null
    }
  }

  function setSavedExpandedCaptureHeight(px) {
    try {
      localStorage.setItem(CAPTURE_EXPANDED_HEIGHT_STORAGE_KEY, String(px))
    } catch {}
  }

  function updateCollapseButton() {
    const panel = el("glazyr-capture-panel")
    const btn = el("glazyr-toggle-capture-size")
    if (!btn) return

    const visible = !!panel && panel.style.display !== "none" && !!panel.style.display
    btn.disabled = !visible
    if (!visible) {
      btn.textContent = "▾"
      return
    }

    const h = panel.getBoundingClientRect().height || 0
    const isCollapsed = h <= CAPTURE_COLLAPSED_HEIGHT_PX + 6
    btn.textContent = isCollapsed ? "▴" : "▾"
  }

  function applyCaptureHeight(px) {
    const panel = el("glazyr-capture-panel")
    if (!panel) return
    panel.style.height = `${px}px`

    // Make preview shrink to "thumbnail" size when the panel is small.
    const img = el("glazyr-capture-preview")
    if (img) {
      const maxImg = clamp(px - 54, 48, 180)
      img.style.maxHeight = `${maxImg}px`
    }

    // Keep OCR text scrollable within remaining space.
    const res = el("glazyr-capture-result")
    if (res) {
      const maxRes = clamp(px - 90, 40, 900)
      res.style.maxHeight = `${maxRes}px`
    }

    updateCollapseButton()
  }

  function initCaptureResizer() {
    const panel = el("glazyr-capture-panel")
    const resizer = el("glazyr-capture-resizer")
    if (!panel || !resizer) return

    const defaultPx = 220
    const saved = getSavedCaptureHeight()
    applyCaptureHeight(saved ?? defaultPx)

    let dragging = false
    let startY = 0
    let startH = 0

    const onMove = (e) => {
      if (!dragging) return
      const y = e?.clientY ?? (e?.touches?.[0]?.clientY ?? 0)
      const delta = y - startY
      const headerH = 52
      const minPx = 86 // status + tiny preview
      const maxPx = Math.max(minPx, Math.floor(window.innerHeight - headerH - 120)) // leave room for chat
      const next = clamp(startH + delta, minPx, maxPx)
      applyCaptureHeight(next)
    }

    const stop = () => {
      if (!dragging) return
      dragging = false
      document.body.style.userSelect = ""
      const h = panel.getBoundingClientRect().height
      setSavedCaptureHeight(Math.round(h))
      // Treat whatever the user leaves it at as the "expanded" size unless it's collapsed.
      if (h > CAPTURE_COLLAPSED_HEIGHT_PX + 6) setSavedExpandedCaptureHeight(Math.round(h))
      window.removeEventListener("mousemove", onMove, true)
      window.removeEventListener("mouseup", stop, true)
      window.removeEventListener("touchmove", onMove, { capture: true })
      window.removeEventListener("touchend", stop, { capture: true })
    }

    const start = (e) => {
      // Only allow resizing when capture panel is visible.
      if (panel.style.display === "none" || !panel.style.display) return
      dragging = true
      startY = e?.clientY ?? (e?.touches?.[0]?.clientY ?? 0)
      startH = panel.getBoundingClientRect().height || defaultPx
      document.body.style.userSelect = "none"
      window.addEventListener("mousemove", onMove, true)
      window.addEventListener("mouseup", stop, true)
      window.addEventListener("touchmove", onMove, { capture: true })
      window.addEventListener("touchend", stop, { capture: true })
    }

    resizer.addEventListener("mousedown", start)
    resizer.addEventListener("touchstart", start, { passive: true })
  }

  function initCollapseButton() {
    const btn = el("glazyr-toggle-capture-size")
    const panel = el("glazyr-capture-panel")
    if (!btn || !panel) return

    btn.addEventListener("click", () => {
      if (panel.style.display === "none" || !panel.style.display) return

      const h = panel.getBoundingClientRect().height || 0
      const isCollapsed = h <= CAPTURE_COLLAPSED_HEIGHT_PX + 6

      if (!isCollapsed) {
        // Collapse: remember current expanded height.
        setSavedExpandedCaptureHeight(Math.round(h))
        applyCaptureHeight(CAPTURE_COLLAPSED_HEIGHT_PX)
        setSavedCaptureHeight(CAPTURE_COLLAPSED_HEIGHT_PX)
      } else {
        // Expand: restore last expanded (or current saved/default).
        const expanded = getSavedExpandedCaptureHeight() ?? getSavedCaptureHeight() ?? 220
        const next = Math.max(expanded, CAPTURE_COLLAPSED_HEIGHT_PX + 20)
        applyCaptureHeight(next)
        setSavedCaptureHeight(next)
      }

      updateCollapseButton()
    })

    updateCollapseButton()
  }

  function showCapturePanel(show) {
    const p = el("glazyr-capture-panel")
    if (!p) return
    p.style.display = show ? "block" : "none"

    const r = el("glazyr-capture-resizer")
    if (r) r.style.display = show ? "block" : "none"

    // Apply saved height whenever it becomes visible (handles reloads).
    if (show) {
      const saved = getSavedCaptureHeight()
      if (saved) applyCaptureHeight(saved)
    }

    updateCollapseButton()
  }

  function setStatus(text) {
    const s = el("glazyr-capture-status")
    if (s) s.textContent = text
    // Only show the panel when there's something to show.
    if (text) showCapturePanel(true)
  }

  function isExpanded() {
    const res = el("glazyr-capture-result")
    const resVisible = res && res.style.display !== "none" && !!res.textContent
    return !!resVisible
  }

  function autoCondenseStatus() {
    // Keep the panel as one line unless we have preview/result.
    if (isExpanded()) return
    const s = el("glazyr-capture-status")
    if (!s) return
    // Hide panel entirely when there's nothing to show.
    if (!s.textContent) showCapturePanel(false)
  }

  function setPreview(dataUrl) {
    // Screenshot preview removed from widget; keep status-only panel.
    void dataUrl
  }

  function setResult(text) {
    const r = el("glazyr-capture-result")
    if (!r) return
    if (!text) {
      r.style.display = "none"
      r.textContent = ""
      autoCondenseStatus()
      return
    }
    r.textContent = text
    r.style.display = "block"
    showCapturePanel(true)
  }

  function wireMessages() {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg?.type) return

      if (msg.type === "CAPTURE_HINT") {
        if (msg.text) setStatus(msg.text)
      } else if (msg.type === "CAPTURE_STARTED") {
        setStatus("Capturing screenshot…")
        setResult("")
      } else if (msg.type === "CAPTURE_DONE") {
        setStatus("Captured. Analyzing…")
        if (msg.imageDataUrl) setPreview(msg.imageDataUrl)
      } else if (msg.type === "ANALYSIS_RESULT") {
        setStatus("Done.")
        if (msg.imageDataUrl) setPreview(msg.imageDataUrl)
        // Prefer printing OCR into chat instead of dedicating panel space.
        if (msg.text) {
          const ok = appendAssistantMessageToChat(msg.text)
          if (!ok) setResult(msg.text)
          else setResult("")
        }
        autoCondenseStatus()
      } else if (msg.type === "ANALYSIS_ERROR") {
        setStatus("Error.")
        const text = msg.text || "Unknown error"
        const ok = appendAssistantMessageToChat(`OCR error:\n${text}`)
        if (!ok) setResult(text)
      } else if (msg.type === "STT_STATUS") {
        if (msg.text) setStatus(msg.text)
      } else if (msg.type === "STT_ERROR") {
        setStatus("STT error.")
        setResult(msg.text || "Unknown STT error")
      } else if (msg.type === "STT_RESULT") {
        const text = String(msg.text || "").trim()
        if (!text) {
          setStatus("No speech detected.")
          return
        }
        setStatus("STT inserted. Edit if needed, then Send.")
        const { input } = getInputAndForm()
        if (input) {
          setReactInputValue(input, text)
          input.focus()
        } else {
          setResult(text)
        }
        autoCondenseStatus()
      }
    })
  }

  function loadLastCapture() {
    chrome.runtime.sendMessage({ type: "GET_LAST_CAPTURE" }, (res) => {
      const last = res?.lastCapture
      if (!last) return
      if (last.imageDataUrl) setPreview(last.imageDataUrl)
      // Don't auto-print old OCR into the panel; new OCR results will be printed into chat.
      setResult("")
    })
  }

  // --- Whisper STT (mic button injected next to the React input) ---
  const OPENAI_KEY_STORAGE = "openaiApiKey"

  function helpForMicPermissionError(raw) {
    const msg = String(raw || "")
    const id = chrome?.runtime?.id || "<extension-id>"
    if (!msg) return ""

    const lower = msg.toLowerCase()
    if (lower.includes("permission dismissed") || lower.includes("permission denied") || lower.includes("notallowederror")) {
      return (
        "Microphone permission was dismissed/denied.\n\n" +
        "Fix:\n" +
        "1) Click the mic again and choose Allow.\n" +
        "2) If Chrome won't prompt anymore, open the Glazyr mic setup page to re-trigger the prompt.\n" +
        "3) Or: open `chrome://settings/content/microphone` and allow `chrome-extension://" +
        id +
        "`.\n" +
        "3) Ensure the correct input device is selected in Microphone settings.\n"
      )
    }

    return ""
  }

  function getInputAndForm() {
    const root = document.getElementById("root")
    if (!root) return { form: null, input: null, sendBtn: null }

    // React bundle may change placeholder; keep this selector broad.
    const input =
      root.querySelector('input[placeholder="Ask Glazyr a question..."]') ||
      root.querySelector('form input[type="text"]') ||
      root.querySelector('input[type="text"]')
    const form = input ? input.closest("form") : null
    const sendBtn =
      form?.querySelector?.('button[type="submit"]') ||
      form?.querySelector?.("button") ||
      null
    return { form, input, sendBtn }
  }

  function findChatScrollContainer() {
    const root = document.getElementById("root")
    if (!root) return null

    // Heuristic: pick the largest scrollable container inside the React root.
    const divs = Array.from(root.querySelectorAll("div"))
    let best = null
    let bestH = 0
    for (const d of divs) {
      const h = d.clientHeight || 0
      if (h < 120) continue
      if ((d.scrollHeight || 0) <= h + 2) continue
      if (h > bestH) {
        best = d
        bestH = h
      }
    }
    return best
  }

  function appendAssistantMessageToChat(text) {
    const msg = String(text || "").trim()
    if (!msg) return false

    const scroller = findChatScrollContainer()
    if (!scroller) return false

    // Create a simple assistant bubble.
    const wrap = document.createElement("div")
    wrap.style.display = "flex"
    wrap.style.justifyContent = "flex-start"
    wrap.style.padding = "6px 10px"

    const bubble = document.createElement("div")
    bubble.style.maxWidth = "92%"
    bubble.style.border = "1px solid rgba(0,0,0,0.10)"
    bubble.style.borderRadius = "12px"
    bubble.style.padding = "10px 12px"
    bubble.style.background = "#ffffff"
    bubble.style.color = "#0b0f14"
    bubble.style.whiteSpace = "pre-wrap"
    bubble.style.fontSize = "13px"
    bubble.textContent = msg

    wrap.appendChild(bubble)
    scroller.appendChild(wrap)

    try {
      scroller.scrollTop = scroller.scrollHeight
    } catch {}

    return true
  }

  function setReactInputValue(input, value) {
    input.value = value
    input.dispatchEvent(new Event("input", { bubbles: true }))
  }

  function getOpenAIKey(cb) {
    chrome.storage.local.get([OPENAI_KEY_STORAGE], (res) => cb(res?.[OPENAI_KEY_STORAGE] || ""))
  }

  function setOpenAIKey(key, cb) {
    chrome.storage.local.set({ [OPENAI_KEY_STORAGE]: key }, () => cb?.())
  }

  function ensureKeyThen(cb) {
    getOpenAIKey((key) => {
      if (key) return cb(key)
      const entered = prompt("Enter your OpenAI API key for Whisper STT (stored locally):")
      if (!entered) {
        setStatus("STT key not set.")
        return
      }
      setOpenAIKey(entered.trim(), () => cb(entered.trim()))
    })
  }

  async function blobToArrayBuffer(blob) {
    return await blob.arrayBuffer()
  }

  function installMicButton() {
    const { form, input, sendBtn } = getInputAndForm()
    if (!form || !input || !sendBtn) return false
    if (form.querySelector(".glazyr-mic-btn")) return true

    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "glazyr-mic-btn"
    btn.title = "Voice input (Whisper STT)"
    btn.textContent = "🎙"

    // Insert between input and Send button (works with the existing flex layout)
    try {
      sendBtn.insertAdjacentElement("beforebegin", btn)
    } catch {
      form.appendChild(btn)
    }

    let recording = false

    async function start() {
      ensureKeyThen(async () => {
        try {
          chrome.runtime.sendMessage({ type: "STT_RECORD_START" }, (res) => {
            if (chrome.runtime.lastError) {
              setStatus("STT error.")
              setResult(chrome.runtime.lastError.message)
              return
            }
            if (!res?.ok) {
              setStatus("STT error.")
              const errText = res?.error || "Could not start recording."
              setResult(helpForMicPermissionError(errText) || errText)
              if (String(errText).toLowerCase().includes("permission")) {
                const ok = confirm("Microphone permission is blocked. Open the Glazyr mic setup page to enable it?")
                if (ok) chrome.tabs.create({ url: chrome.runtime.getURL("mic_setup.html") })
              }
              return
            }
            recording = true
            btn.classList.add("recording")
            btn.textContent = "⏹"
            setStatus("Recording… click again to stop.")
          })
        } catch (e) {
          setStatus("Mic permission denied or unavailable.")
          const errText = String(e?.message || e)
          setResult(helpForMicPermissionError(errText) || errText)
        }
      })
    }

    function stop() {
      try {
        chrome.runtime.sendMessage({ type: "STT_RECORD_STOP" }, (res) => {
          if (chrome.runtime.lastError) {
            setStatus("STT error.")
            setResult(chrome.runtime.lastError.message)
            return
          }
          if (!res?.ok) {
            setStatus("STT error.")
            const errText = res?.error || "Could not stop recording."
            setResult(helpForMicPermissionError(errText) || errText)
            return
          }
          // actual transcript comes via STT_RESULT message
          setStatus("Transcribing…")
        })
        recording = false
        btn.classList.remove("recording")
        btn.textContent = "🎙"
      } catch (e) {
        setStatus("STT error.")
        setResult(String(e?.message || e))
      }
    }

    btn.addEventListener("click", () => {
      if (recording) stop()
      else start()
    })

    return true
  }

  function wire() {
    const btn = document.getElementById("glazyr-framed-shot")
    if (btn) btn.addEventListener("click", startFramedScreenshot)

    const closeBtn = document.getElementById("glazyr-close-widget")
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        // Extension pages can throw "Extension context invalidated" right after reloads.
        // Guard + fail silently (closing the widget isn't safety-critical).
        try {
          if (!chrome?.runtime?.id) return
          // Prefer sending to background; it knows how to toggle the widget in the active tab.
          chrome.runtime.sendMessage({ type: "TOGGLE_WIDGET" }, () => void chrome.runtime.lastError)
        } catch {
          // ignore
        }
      })
    }

    wireMessages()
    loadLastCapture()
    // Resizer/collapse controls removed with screenshot preview UI.

    // React renders asynchronously and may re-render; keep mic button installed.
    try {
      const ensure = () => {
        try {
          installMicButton()
        } catch (e) {
          setStatus("Mic UI error.")
          setResult(String(e?.message || e))
        }
      }

      ensure()

      const root = document.getElementById("root")
      if (root && "MutationObserver" in window) {
        const mo = new MutationObserver(() => ensure())
        mo.observe(root, { childList: true, subtree: true })
      }
    } catch (e) {
      setStatus("Mic UI error.")
      setResult(String(e?.message || e))
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire)
  } else {
    wire()
  }
})()


