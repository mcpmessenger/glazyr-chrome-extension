(() => {
  const OVERLAY_ID = "glazyr-region-overlay"
  const BOX_ID = "glazyr-region-box"
  const HUD_ID = "glazyr-region-hud"

  let active = false
  let startX = 0
  let startY = 0
  let currentX = 0
  let currentY = 0
  let dragging = false
  let confirmed = false

  function normalizeDomain(input) {
    const raw = String(input || "").trim().toLowerCase()
    if (!raw) return ""
    const noScheme = raw.replace(/^[a-z]+:\/\//i, "")
    const hostAndMaybePort = noScheme.split("/")[0]
    return hostAndMaybePort.split(":")[0]
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
    return h === p || h.endsWith("." + p)
  }

  function policyAllowsCapture() {
    const p = (window && window.__glazyrPolicy) || {}
    if (p.killSwitchEngaged) return { ok: false, reason: "Kill switch is engaged." }
    const allowed = Array.isArray(p.allowedDomains) ? p.allowedDomains : []
    if (allowed.length) {
      const host = String(window.location.hostname || "")
      const ok = allowed.some((d) => hostMatchesPattern(host, d))
      if (!ok) return { ok: false, reason: "Domain is not in allowed domains." }
    }
    return { ok: true, reason: "" }
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n))
  }

  function getOverlay() {
    return document.getElementById(OVERLAY_ID)
  }

  function cleanup() {
    active = false
    dragging = false
    confirmed = false
    const el = getOverlay()
    if (el) el.remove()
    window.removeEventListener("keydown", onKeyDown, true)
  }

  function updateUI() {
    const overlay = getOverlay()
    if (!overlay) return
    const box = overlay.querySelector(`#${BOX_ID}`)
    const hud = overlay.querySelector(`#${HUD_ID}`)
    if (!box || !hud) return

    const left = Math.min(startX, currentX)
    const top = Math.min(startY, currentY)
    const right = Math.max(startX, currentX)
    const bottom = Math.max(startY, currentY)

    const width = Math.max(0, right - left)
    const height = Math.max(0, bottom - top)

    box.style.left = `${left}px`
    box.style.top = `${top}px`
    box.style.width = `${width}px`
    box.style.height = `${height}px`

    hud.textContent =
      width >= 1 && height >= 1
        ? `Selected: ${Math.round(width)}×${Math.round(height)}  (Release=Capture, Esc=Cancel)`
        : `Drag to select an area  (Release=Capture, Esc=Cancel)`
  }

  function getRect() {
    const left = Math.min(startX, currentX)
    const top = Math.min(startY, currentY)
    const right = Math.max(startX, currentX)
    const bottom = Math.max(startY, currentY)

    const vw = document.documentElement.clientWidth
    const vh = document.documentElement.clientHeight

    const x = clamp(left, 0, vw)
    const y = clamp(top, 0, vh)
    const w = clamp(right, 0, vw) - x
    const h = clamp(bottom, 0, vh) - y

    return { x, y, width: w, height: h }
  }

  function confirmSelection() {
    if (!active || confirmed) return
    const rect = getRect()
    if (rect.width < 10 || rect.height < 10) {
      // Keep overlay open; just update HUD for guidance.
      const overlay = getOverlay()
      const hud = overlay?.querySelector?.(`#${HUD_ID}`)
      if (hud) hud.textContent = "Selection too small. Drag a larger area (Esc cancels)."
      return
    }

    confirmed = true
    chrome.runtime.sendMessage({
      type: "REGION_SELECTED",
      rect,
      devicePixelRatio: window.devicePixelRatio || 1,
      viewport: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      },
    })

    cleanup()
  }

  function onKeyDown(e) {
    if (!active) return
    if (e.key === "Escape") {
      e.preventDefault()
      cleanup()
    }
  }

  function beginSelection() {
    if (active) return
    const gate = policyAllowsCapture()
    if (!gate.ok) {
      try {
        alert(`Glazyr blocked capture: ${gate.reason}`)
      } catch {}
      return
    }
    active = true

    const existing = getOverlay()
    if (existing) existing.remove()

    const overlay = document.createElement("div")
    overlay.id = OVERLAY_ID
    overlay.style.position = "fixed"
    overlay.style.inset = "0"
    overlay.style.zIndex = "2147483647"
    overlay.style.cursor = "crosshair"
    overlay.style.background = "rgba(0,0,0,0.15)"
    overlay.style.backdropFilter = "blur(0px)"

    const box = document.createElement("div")
    box.id = BOX_ID
    box.style.position = "absolute"
    box.style.border = "2px solid #4cc9f0"
    box.style.background = "rgba(76,201,240,0.10)"
    box.style.boxShadow = "0 0 0 9999px rgba(0,0,0,0.22)"
    box.style.borderRadius = "6px"

    const hud = document.createElement("div")
    hud.id = HUD_ID
    hud.style.position = "absolute"
    hud.style.left = "12px"
    hud.style.bottom = "12px"
    hud.style.padding = "10px 12px"
    hud.style.borderRadius = "10px"
    hud.style.background = "rgba(11,15,20,0.92)"
    hud.style.color = "#e8f1ff"
    hud.style.fontFamily = "Arial, sans-serif"
    hud.style.fontSize = "12px"
    hud.style.border = "1px solid rgba(255,255,255,0.12)"

    overlay.appendChild(box)
    overlay.appendChild(hud)
    document.documentElement.appendChild(overlay)

    function pointerToViewport(evt) {
      const vw = document.documentElement.clientWidth
      const vh = document.documentElement.clientHeight
      return {
        x: clamp(evt.clientX, 0, vw),
        y: clamp(evt.clientY, 0, vh),
      }
    }

    overlay.addEventListener(
      "pointerdown",
      (evt) => {
        evt.preventDefault()
        evt.stopPropagation()
        overlay.setPointerCapture(evt.pointerId)
        dragging = true
        const p = pointerToViewport(evt)
        startX = p.x
        startY = p.y
        currentX = p.x
        currentY = p.y
        updateUI()
      },
      true
    )

    overlay.addEventListener(
      "pointermove",
      (evt) => {
        if (!dragging) return
        evt.preventDefault()
        evt.stopPropagation()
        const p = pointerToViewport(evt)
        currentX = p.x
        currentY = p.y
        updateUI()
      },
      true
    )

    overlay.addEventListener(
      "pointerup",
      (evt) => {
        if (!dragging) return
        evt.preventDefault()
        evt.stopPropagation()
        dragging = false
        const p = pointerToViewport(evt)
        currentX = p.x
        currentY = p.y
        updateUI()
        // Auto-confirm on release for a smoother flow (no Enter required).
        confirmSelection()
      },
      true
    )

    window.addEventListener("keydown", onKeyDown, true)
    updateUI()
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "BEGIN_REGION_SELECT" || msg?.type === "START_CROP_CAPTURE") {
      beginSelection()
      sendResponse?.({ status: "selection_started" })
      return true
    }
  })
})()


