(() => {
  function ensureContentScript(tabId, file, cb) {
    if (!chrome?.scripting?.executeScript) return cb?.()
    chrome.scripting.executeScript({ target: { tabId }, files: [file] }, () => cb?.())
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

  function ensureWidgetContentScript(tabId, cb) {
    ensureContentScript(tabId, "widget_content.js", cb)
  }

  function toggleWidget() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs?.[0]?.id
      if (!tabId) return
      chrome.tabs.sendMessage(tabId, { type: "TOGGLE_WIDGET" }, () => {
        const err = chrome.runtime.lastError
        if (!err) return
        ensureWidgetContentScript(tabId, () => {
          chrome.tabs.sendMessage(tabId, { type: "TOGGLE_WIDGET" }, () => {
            void chrome.runtime.lastError
          })
        })
      })
    })
  }

  function startFramedScreenshot() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs?.[0]?.id
      if (!tabId) return
      setStatus("Select an area on the page: drag to frame, Enter to capture, Esc to cancel.")
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

  function wire() {
    const btn = document.getElementById("glazyr-framed-shot")
    if (btn) btn.addEventListener("click", startFramedScreenshot)

    const widgetBtn = document.getElementById("glazyr-open-widget")
    if (widgetBtn) widgetBtn.addEventListener("click", toggleWidget)

    wireMessages()
    loadLastCapture()
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire)
  } else {
    wire()
  }
})()


