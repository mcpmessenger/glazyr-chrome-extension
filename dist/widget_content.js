(() => {
  const WIDGET_ID = "glazyr-widget-host"
  const STATE_KEY = "glazyrWidgetState"

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n))
  }

  function loadState(cb) {
    try {
      chrome.storage.local.get([STATE_KEY], (res) => cb(res?.[STATE_KEY] || null))
    } catch {
      cb(null)
    }
  }

  function saveState(state) {
    try {
      chrome.storage.local.set({ [STATE_KEY]: state })
    } catch {
      // ignore when extension context is invalidated (reload/navigation)
    }
  }

  function removeWidget() {
    const el = document.getElementById(WIDGET_ID)
    if (el) el.remove()
  }

  function createWidget(state) {
    removeWidget()

    const host = document.createElement("div")
    host.id = WIDGET_ID
    host.style.position = "fixed"
    host.style.zIndex = "2147483646"
    host.style.left = `${state?.x ?? Math.max(16, window.innerWidth - 420)}px`
    host.style.top = `${state?.y ?? 80}px`
    host.style.width = `${state?.w ?? 380}px`
    host.style.height = `${state?.h ?? 560}px`
    host.style.minWidth = "320px"
    host.style.minHeight = "420px"
    host.style.maxWidth = "95vw"
    host.style.maxHeight = "95vh"
    host.style.background = "transparent"
    host.style.resize = "both"
    host.style.overflow = "hidden"
    host.style.borderRadius = "14px"
    host.style.boxShadow = "0 18px 60px rgba(0,0,0,0.45)"

    const bar = document.createElement("div")
    bar.style.height = "30px"
    bar.style.display = "flex"
    bar.style.alignItems = "center"
    bar.style.justifyContent = "space-between"
    bar.style.padding = "0 8px"
    bar.style.cursor = "move"
    bar.style.background = "rgba(11,15,20,0.96)"
    bar.style.border = "1px solid rgba(255,255,255,0.10)"
    bar.style.borderBottom = "0"
    bar.style.borderTopLeftRadius = "14px"
    bar.style.borderTopRightRadius = "14px"
    bar.style.color = "#e8f1ff"
    bar.style.fontFamily = "Arial, sans-serif"
    bar.style.fontSize = "12px"
    bar.style.userSelect = "none"

    // Minimal drag bar: no title and no close button (close is provided inside the widget UI).
    const spacer = document.createElement("div")
    spacer.style.width = "1px"
    spacer.style.height = "1px"
    bar.appendChild(spacer)

    const frame = document.createElement("iframe")
    frame.src = chrome.runtime.getURL("popup.html")
    // Allow microphone inside the iframe when the host page permits it.
    // (Many sites block mic in iframes unless explicitly allowed.)
    frame.allow = "microphone"
    frame.style.width = "100%"
    frame.style.height = "calc(100% - 30px)"
    frame.style.border = "1px solid rgba(255,255,255,0.10)"
    frame.style.borderTop = "0"
    frame.style.borderBottomLeftRadius = "14px"
    frame.style.borderBottomRightRadius = "14px"
    frame.style.background = "white"

    host.appendChild(bar)
    host.appendChild(frame)

    // Drag handling
    let dragging = false
    let dragOffsetX = 0
    let dragOffsetY = 0

    function onMove(e) {
      if (!dragging) return
      const vw = window.innerWidth
      const vh = window.innerHeight
      const rect = host.getBoundingClientRect()
      const newX = clamp(e.clientX - dragOffsetX, 0, vw - rect.width)
      const newY = clamp(e.clientY - dragOffsetY, 0, vh - rect.height)
      host.style.left = `${newX}px`
      host.style.top = `${newY}px`
    }

    function stopDrag() {
      if (!dragging) return
      dragging = false
      document.removeEventListener("pointermove", onMove, true)
      document.removeEventListener("pointerup", stopDrag, true)
      persist()
    }

    bar.addEventListener(
      "pointerdown",
      (e) => {
        e.preventDefault()
        dragging = true
        const rect = host.getBoundingClientRect()
        dragOffsetX = e.clientX - rect.left
        dragOffsetY = e.clientY - rect.top
        document.addEventListener("pointermove", onMove, true)
        document.addEventListener("pointerup", stopDrag, true)
      },
      true
    )

    // Persist size changes (resize: both)
    const ro = new ResizeObserver(() => persist())
    ro.observe(host)

    function persist() {
      const rect = host.getBoundingClientRect()
      saveState({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      })
    }

    document.documentElement.appendChild(host)
  }

  function toggleWidget() {
    const existing = document.getElementById(WIDGET_ID)
    if (existing) {
      existing.remove()
      return
    }
    loadState((state) => createWidget(state))
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "TOGGLE_WIDGET") {
      toggleWidget()
      sendResponse?.({ status: "ok" })
      return true
    }
  })
})()


