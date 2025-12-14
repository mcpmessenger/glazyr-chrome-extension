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

  function ensureFullPageCaptureContentScript(tabId, cb) {
    // If the content script listener isn't present (common after updates),
    // inject the file and retry.
    if (!chrome?.scripting?.executeScript) return cb?.()
    chrome.scripting.executeScript(
      { target: { tabId }, files: ["fullpage_capture_content.js"] },
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

  function startFullPageScreenshot() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs?.[0]?.id
      if (!tabId) return
      const url = tabs?.[0]?.url
      if (isRestrictedUrl(url)) {
        setStatus("Can’t capture on chrome:// or other restricted pages. Open a normal website tab.")
        return
      }
      setStatus("Capturing full page… (scrolling the page briefly)")
      chrome.tabs.sendMessage(tabId, { type: "BEGIN_FULLPAGE_CAPTURE" }, () => {
        const err = chrome.runtime.lastError
        if (!err) return
        // Retry after injecting the full-page capture script
        ensureFullPageCaptureContentScript(tabId, () => {
          chrome.tabs.sendMessage(tabId, { type: "BEGIN_FULLPAGE_CAPTURE" }, () => {
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

  function flashLogo(start) {
    const img = document.querySelector("#glazyr-header img")
    const mobileVideo = document.querySelector("#glazyr-header video.mobile-logo")
    const desktopVideo = document.querySelector("#glazyr-header video.desktop-logo")
    
    if (start) {
      // Hide static image
      if (img) img.classList.add("flashing")
      
      // Determine which video to show based on screen width
      const isMobile = window.innerWidth < 600
      const activeVideo = isMobile ? mobileVideo : desktopVideo
      
      if (activeVideo) {
        activeVideo.classList.add("flashing")
        activeVideo.currentTime = 0 // Reset to start
        activeVideo.play().catch((err) => {
          console.log("Video play error:", err)
        })
      }
    } else {
      // Show static image
      if (img) img.classList.remove("flashing")
      
      // Hide and pause all videos
      if (mobileVideo) {
        mobileVideo.classList.remove("flashing")
        mobileVideo.pause()
        mobileVideo.currentTime = 0
      }
      if (desktopVideo) {
        desktopVideo.classList.remove("flashing")
        desktopVideo.pause()
        desktopVideo.currentTime = 0
      }
    }
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
        // Don't accidentally slurp metadata from our OCR-only fallback format.
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

    // If this isn't the structured vision string, fall back to a short quote.
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
      // If we don't have a caption, fall back to a short "gist" from the text itself.
      const compact = normalizeWhitespace(p.text)
      const m = compact.match(/^[\s\S]{1,600}?[.?!](\s|$)/)
      const firstSentence = (m ? m[0] : compact).trim()
      summary = firstSentence.length > 240 ? firstSentence.slice(0, 240) + "…" : firstSentence
    }

    summary = String(summary || "").trim()
    if (summary.length > 900) summary = summary.slice(0, 900) + "…"

    return `Quoted text: "${quoted}"\nSummary: ${summary || "(no summary)"}`
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
          const shown = formatVisionAnalysisForUser(msg.text)
          const ok = appendAssistantMessageToChat(shown)
          if (!ok) setResult(shown)
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
        const errorText = msg.text || "Unknown STT error"
        setStatus(`STT error: ${errorText}`)
        setResult(errorText)
        console.error("STT Error:", errorText)
      } else if (msg.type === "STT_RESULT") {
        const text = String(msg.text || "").trim()
        if (!text) {
          setStatus("No speech detected.")
          return
        }
        setStatus("STT inserted. Ready to send.")
        const { input, form, sendBtn } = getInputAndForm()
        if (input) {
          setReactInputValue(input, text)
          
          // Ensure Send button is enabled - try multiple approaches
          setTimeout(() => {
            // Verify the value was set
            if (input.value !== text) {
              // Try setting it again
              setReactInputValue(input, text)
            }
            
            // Trigger additional events to ensure React recognizes the change
            const events = ["input", "change", "keyup", "keydown"]
            events.forEach(eventType => {
              const evt = new Event(eventType, { bubbles: true, cancelable: true })
              Object.defineProperty(evt, "target", { value: input, enumerable: true })
              input.dispatchEvent(evt)
            })
            
            // If Send button is still disabled, try to enable it directly
            if (sendBtn && sendBtn.disabled && input.value.trim()) {
              // Remove disabled attribute (React might re-add it, but worth trying)
              sendBtn.removeAttribute("disabled")
              // Try clicking programmatically to see if that helps React recognize state
              // (We won't actually submit, just trigger the click handler if it checks state)
            }
            
            // Focus the input to ensure it's ready
            input.focus()
          }, 150)
        } else {
          setResult(text)
        }
        autoCondenseStatus()
      } else if (msg.type === "RUNTIME_TASK_STATUS") {
        const status = String(msg.status || "").trim()
        const taskId = String(msg.taskId || "").trim()
        const summary = String(msg.summary || "").trim()

        if (status) {
          setStatus(taskId ? `Runtime: ${status} (${taskId.slice(0, 8)}…)` : `Runtime: ${status}`)
        } else if (taskId) {
          setStatus(`Runtime: ${taskId.slice(0, 8)}…`)
        }

        // If the runtime provides a short summary/output, show it as an assistant bubble.
        if (summary) {
          appendAssistantMessageToChat(`Runtime update:\n${summary.slice(0, 1600)}`)
        }
      } else if (msg.type === "PAGE_CONTEXT_LOADING") {
        // Flash the logo when waiting for page context to load
        flashLogo(true)
      } else if (msg.type === "PAGE_CONTEXT_LOADED") {
        // Stop flashing when page context is loaded
        flashLogo(false)
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
    // Simulate user interaction: focus first
    input.focus()
    const focusEvent = new Event("focus", { bubbles: true, cancelable: true })
    input.dispatchEvent(focusEvent)
    
    // Use native value setter to bypass React's restrictions
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(input, value)
    } else {
      input.value = value
    }
    
    // Create and dispatch a proper input event that React will recognize
    const inputEvent = new Event("input", { bubbles: true, cancelable: true })
    Object.defineProperty(inputEvent, "target", { value: input, enumerable: true })
    Object.defineProperty(inputEvent, "currentTarget", { value: input, enumerable: true })
    input.dispatchEvent(inputEvent)
    
    // Also dispatch change event
    const changeEvent = new Event("change", { bubbles: true, cancelable: true })
    Object.defineProperty(changeEvent, "target", { value: input, enumerable: true })
    Object.defineProperty(changeEvent, "currentTarget", { value: input, enumerable: true })
    input.dispatchEvent(changeEvent)
    
    // Trigger keyboard events to simulate typing
    const keydownEvent = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "a" })
    input.dispatchEvent(keydownEvent)
    
    const keyupEvent = new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: "a" })
    input.dispatchEvent(keyupEvent)
    
    // Keep focus on the input
    input.focus()
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

    const fullBtn = document.getElementById("glazyr-fullpage-shot")
    if (fullBtn) fullBtn.addEventListener("click", startFullPageScreenshot)

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

  // Listen for messages from parent window (drag bar buttons)
  // The parent is a content script, so it may have a different origin (the page's origin)
  // We accept messages with our expected structure from any origin since we control the parent
  window.addEventListener("message", (event) => {
    // Only process messages with our expected structure
    if (!event.data || typeof event.data !== "object" || !event.data.type) {
      return
    }
    
    if (event.data.type === "FRAMED_SHOT_CLICK") {
      startFramedScreenshot()
    } else if (event.data.type === "FULLPAGE_SHOT_CLICK") {
      startFullPageScreenshot()
    } else if (event.data.type === "CLOSE_WIDGET_CLICK") {
      try {
        if (!chrome?.runtime?.id) return
        chrome.runtime.sendMessage({ type: "TOGGLE_WIDGET" }, () => void chrome.runtime.lastError)
      } catch {
        // ignore
      }
    }
  })

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire)
  } else {
    wire()
  }
})()


