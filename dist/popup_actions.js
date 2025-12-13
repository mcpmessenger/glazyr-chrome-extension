(() => {
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

  function getInputAndForm() {
    const root = document.getElementById("root")
    if (!root) return { form: null, input: null, sendBtn: null }

    const input = root.querySelector('input[placeholder="Ask Glazyr a question..."]')
    const form = input ? input.closest("form") : null
    const sendBtn = form ? form.querySelector('button[type="submit"]') : null
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
    sendBtn.insertAdjacentElement("beforebegin", btn)

    let mediaRecorder = null
    let chunks = []
    let stream = null
    let recording = false

    async function start() {
      ensureKeyThen(async () => {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          const mimeType =
            MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm"
          mediaRecorder = new MediaRecorder(stream, { mimeType })
          chunks = []

          mediaRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) chunks.push(e.data)
          }
          mediaRecorder.onstop = async () => {
            try {
              const blob = new Blob(chunks, { type: mimeType })
              setStatus("Transcribing…")
              const audio = await blobToArrayBuffer(blob)

              chrome.runtime.sendMessage(
                { type: "STT_TRANSCRIBE", mimeType: blob.type || mimeType, audio },
                (res) => {
                  if (chrome.runtime.lastError) {
                    setStatus("STT error.")
                    setResult(chrome.runtime.lastError.message)
                    return
                  }
                  if (!res?.ok) {
                    setStatus("STT error.")
                    setResult(res?.error || "Unknown STT error")
                    return
                  }

                  const text = String(res.text || "").trim()
                  if (!text) {
                    setStatus("No speech detected.")
                    return
                  }

                  setStatus("STT inserted. Edit if needed, then Send.")
                  setReactInputValue(input, text)
                  input.focus()
                }
              )
            } finally {
              // cleanup stream
              try {
                stream?.getTracks?.().forEach((t) => t.stop())
              } catch {}
              stream = null
              mediaRecorder = null
              chunks = []
              recording = false
              btn.classList.remove("recording")
              btn.textContent = "🎙"
            }
          }

          recording = true
          btn.classList.add("recording")
          btn.textContent = "⏹"
          setStatus("Recording… click again to stop.")
          mediaRecorder.start()
        } catch (e) {
          setStatus("Mic permission denied or unavailable.")
          setResult(String(e?.message || e))
        }
      })
    }

    function stop() {
      try {
        mediaRecorder?.stop()
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

    // React renders asynchronously; keep trying until the input exists.
    const tryInstall = () => {
      if (installMicButton()) return
      setTimeout(tryInstall, 300)
    }
    tryInstall()
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire)
  } else {
    wire()
  }
})()


