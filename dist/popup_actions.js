(() => {
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

  function setStatus(text) {
    const s = el("glazyr-capture-status")
    if (s) s.textContent = text
  }

  function setPreview(dataUrl) {
    const img = el("glazyr-capture-preview")
    if (!img) return
    if (!dataUrl) {
      img.style.display = "none"
      img.removeAttribute("src")
      return
    }
    img.src = dataUrl
    img.style.display = "block"
  }

  function setResult(text) {
    const r = el("glazyr-capture-result")
    if (!r) return
    if (!text) {
      r.style.display = "none"
      r.textContent = ""
      return
    }
    r.textContent = text
    r.style.display = "block"
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
        if (msg.text) setResult(msg.text)
      } else if (msg.type === "ANALYSIS_ERROR") {
        setStatus("Error.")
        setResult(msg.text || "Unknown error")
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
      }
    })
  }

  function loadLastCapture() {
    chrome.runtime.sendMessage({ type: "GET_LAST_CAPTURE" }, (res) => {
      const last = res?.lastCapture
      if (!last) return
      if (last.imageDataUrl) setPreview(last.imageDataUrl)
      if (last.analysisText) setResult(last.analysisText)
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

    wireMessages()
    loadLastCapture()

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


