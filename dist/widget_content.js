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

    const vw = window.innerWidth
    const vh = window.innerHeight
    const margin = 16

    const minW = 320
    const minH = 420

    const desiredW = Number(state?.w ?? 380)
    const desiredH = Number(state?.h ?? 560)

    // Default to a size that fits on smaller screens.
    const w = clamp(desiredW, minW, Math.max(minW, vw - margin * 2))
    const h = clamp(desiredH, minH, Math.max(minH, vh - margin * 2))

    // Default position: slightly higher and never off-screen.
    const defaultX = Math.max(margin, vw - w - margin)
    const defaultY = 48

    const x = clamp(Number(state?.x ?? defaultX), 0, Math.max(0, vw - w))
    const y = clamp(Number(state?.y ?? defaultY), 0, Math.max(0, vh - h))

    const host = document.createElement("div")
    host.id = WIDGET_ID
    host.style.position = "fixed"
    host.style.zIndex = "2147483646"
    host.style.left = `${x}px`
    host.style.top = `${y}px`
    host.style.width = `${w}px`
    host.style.height = `${h}px`
    host.style.minWidth = `${minW}px`
    host.style.minHeight = `${minH}px`
    host.style.maxWidth = "95vw"
    host.style.maxHeight = "95vh"
    host.style.background = "transparent"
    host.style.resize = "both"
    host.style.overflow = "hidden"
    host.style.borderRadius = "14px"
    host.style.boxShadow = "0 18px 60px rgba(0,0,0,0.45)"

    // Create frame first so buttons can reference it
    const frame = document.createElement("iframe")
    frame.src = chrome.runtime.getURL("popup.html")
    // Allow microphone inside the iframe when the host page permits it.
    // (Many sites block mic in iframes unless explicitly allowed.)
    frame.allow = "microphone"
    frame.style.width = "100%"
    frame.style.height = "calc(100% - 52px)"
    frame.style.border = "1px solid rgba(255,255,255,0.10)"
    frame.style.borderTop = "0"
    frame.style.borderBottomLeftRadius = "14px"
    frame.style.borderBottomRightRadius = "14px"
    frame.style.background = "white"

    const bar = document.createElement("div")
    bar.style.height = "52px"
    bar.style.display = "flex"
    bar.style.alignItems = "center"
    bar.style.justifyContent = "space-between"
    bar.style.padding = "0 12px"
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
    bar.style.position = "relative"
    bar.style.zIndex = "1000"

    // Left section with logo
    const leftSection = document.createElement("div")
    leftSection.style.display = "flex"
    leftSection.style.alignItems = "center"
    leftSection.style.gap = "10px"
    leftSection.style.cursor = "move"
    leftSection.style.flex = "1"
    leftSection.style.minWidth = "0"
    
    const logoImg = document.createElement("img")
    logoImg.src = chrome.runtime.getURL("logo.png")
    logoImg.alt = "Glazyr logo"
    logoImg.style.width = "32px"
    logoImg.style.height = "32px"
    logoImg.style.borderRadius = "10px"
    logoImg.style.objectFit = "cover"
    logoImg.style.flexShrink = "0"
    logoImg.style.pointerEvents = "none"
    logoImg.onerror = () => {
      console.error("Failed to load logo.png from:", logoImg.src)
      // Fallback: try icon48.png if logo.png fails
      logoImg.src = chrome.runtime.getURL("icons/icon48.png")
    }
    logoImg.onload = () => {
      console.log("Logo loaded successfully")
    }
    leftSection.appendChild(logoImg)
    
    bar.appendChild(leftSection)

    // Right section with buttons
    const rightSection = document.createElement("div")
    rightSection.style.display = "flex"
    rightSection.style.alignItems = "center"
    rightSection.style.gap = "8px"
    rightSection.style.cursor = "default"
    rightSection.style.flexShrink = "0"
    
    // Framed shot button
    const framedBtn = document.createElement("button")
    framedBtn.textContent = "Framed shot"
    framedBtn.title = "Viewport-only framed screenshot"
    framedBtn.style.height = "34px"
    framedBtn.style.padding = "0 10px"
    framedBtn.style.borderRadius = "10px"
    framedBtn.style.border = "1px solid rgba(255, 255, 255, 0.14)"
    framedBtn.style.background = "rgba(255, 255, 255, 0.06)"
    framedBtn.style.color = "#e8f1ff"
    framedBtn.style.cursor = "pointer"
    framedBtn.style.fontFamily = "Arial, sans-serif"
    framedBtn.style.fontSize = "12px"
    framedBtn.style.lineHeight = "1"
    framedBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      frame.contentWindow?.postMessage({ type: "FRAMED_SHOT_CLICK" }, "*")
    })
    framedBtn.addEventListener("mousedown", (e) => e.stopPropagation())
    rightSection.appendChild(framedBtn)
    
    // Full page button
    const fullPageBtn = document.createElement("button")
    fullPageBtn.textContent = "Full page"
    fullPageBtn.title = "Full page screenshot (scroll + stitch)"
    fullPageBtn.style.height = "34px"
    fullPageBtn.style.padding = "0 10px"
    fullPageBtn.style.borderRadius = "10px"
    fullPageBtn.style.border = "1px solid rgba(255, 255, 255, 0.14)"
    fullPageBtn.style.background = "rgba(255, 255, 255, 0.06)"
    fullPageBtn.style.color = "#e8f1ff"
    fullPageBtn.style.cursor = "pointer"
    fullPageBtn.style.fontFamily = "Arial, sans-serif"
    fullPageBtn.style.fontSize = "12px"
    fullPageBtn.style.lineHeight = "1"
    fullPageBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      frame.contentWindow?.postMessage({ type: "FULLPAGE_SHOT_CLICK" }, "*")
    })
    fullPageBtn.addEventListener("mousedown", (e) => e.stopPropagation())
    rightSection.appendChild(fullPageBtn)
    
    // Close button
    const closeBtn = document.createElement("button")
    closeBtn.textContent = "×"
    closeBtn.title = "Close"
    closeBtn.style.height = "34px"
    closeBtn.style.width = "34px"
    closeBtn.style.minWidth = "34px"
    closeBtn.style.padding = "0"
    closeBtn.style.borderRadius = "10px"
    closeBtn.style.border = "1px solid rgba(255, 255, 255, 0.14)"
    closeBtn.style.background = "rgba(255, 255, 255, 0.06)"
    closeBtn.style.color = "#e8f1ff"
    closeBtn.style.cursor = "pointer"
    closeBtn.style.fontFamily = "Arial, sans-serif"
    closeBtn.style.fontSize = "18px"
    closeBtn.style.lineHeight = "1"
    closeBtn.style.display = "inline-flex"
    closeBtn.style.alignItems = "center"
    closeBtn.style.justifyContent = "center"
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      frame.contentWindow?.postMessage({ type: "CLOSE_WIDGET_CLICK" }, "*")
    })
    closeBtn.addEventListener("mousedown", (e) => e.stopPropagation())
    rightSection.appendChild(closeBtn)
    
    bar.appendChild(rightSection)
    
    // Add hover effects
    const addHoverEffect = (btn) => {
      btn.addEventListener("mouseenter", () => {
        btn.style.background = "rgba(255, 255, 255, 0.1)"
      })
      btn.addEventListener("mouseleave", () => {
        btn.style.background = "rgba(255, 255, 255, 0.06)"
      })
    }
    addHoverEffect(framedBtn)
    addHoverEffect(fullPageBtn)
    addHoverEffect(closeBtn)

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

    // Only allow dragging from the left section (logo area), not from buttons
    leftSection.addEventListener(
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
    
    // Also allow dragging from empty space in the bar
    bar.addEventListener(
      "pointerdown",
      (e) => {
        // Only drag if clicking directly on the bar, not on child elements (buttons)
        if (e.target === bar || e.target === leftSection || e.target === logoImg) {
          e.preventDefault()
          dragging = true
          const rect = host.getBoundingClientRect()
          dragOffsetX = e.clientX - rect.left
          dragOffsetY = e.clientY - rect.top
          document.addEventListener("pointermove", onMove, true)
          document.addEventListener("pointerup", stopDrag, true)
        }
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


