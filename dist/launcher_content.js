// In-page launcher button for opening/closing the Glazyr widget.
// Replaces the old "Glazyr Mock Button".

(() => {
  const LAUNCHER_ID = "glazyr-launcher"
  const LEGACY_MOCK_ID = "mock-button"
  const POS_KEY = "glazyrLauncherPos"

  function removeLegacyMockButton() {
    try {
      const old = document.getElementById(LEGACY_MOCK_ID)
      if (old) old.remove()
    } catch {}
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n))
  }

  function createLauncher() {
    if (document.getElementById(LAUNCHER_ID)) return

    const btn = document.createElement("button")
    btn.id = LAUNCHER_ID
    btn.type = "button"
    btn.title = "Open Glazyr"

    btn.style.position = "fixed"
    btn.style.zIndex = "2147483647"
    // Logo-only launcher (no dark circle behind it)
    btn.style.width = "52px"
    btn.style.height = "52px"
    btn.style.borderRadius = "14px"
    btn.style.border = "0"
    btn.style.background = "transparent"
    btn.style.boxShadow = "none"
    btn.style.display = "flex"
    btn.style.alignItems = "center"
    btn.style.justifyContent = "center"
    btn.style.padding = "0"
    btn.style.cursor = "pointer"
    btn.style.userSelect = "none"
    btn.style.touchAction = "none"

    const img = document.createElement("img")
    img.alt = "Glazyr"
    img.src = chrome.runtime.getURL("icons/icon48.png")
    img.onerror = () => {
      // Fallback if icons aren't accessible for some reason.
      try {
        img.src = chrome.runtime.getURL("logo.png")
      } catch {}
    }
    img.style.width = "48px"
    img.style.height = "48px"
    img.style.borderRadius = "999px"
    img.style.display = "block"
    img.style.boxShadow = "0 10px 28px rgba(0,0,0,0.28)"
    btn.appendChild(img)

    // Default position bottom-right, but restore if we have one saved.
    try {
      chrome.storage.local.get([POS_KEY], (res) => {
        const p = res?.[POS_KEY]
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
          btn.style.left = `${p.x}px`
          btn.style.top = `${p.y}px`
          btn.style.right = ""
          btn.style.bottom = ""
        } else {
          btn.style.right = "14px"
          btn.style.bottom = "14px"
        }
      })
    } catch {
      btn.style.right = "14px"
      btn.style.bottom = "14px"
    }

    // Drag logic (pointer events)
    let dragging = false
    let offsetX = 0
    let offsetY = 0
    let downX = 0
    let downY = 0

    function onMove(e) {
      if (!dragging) return
      const rect = btn.getBoundingClientRect()
      const x = clamp((e.clientX || 0) - offsetX, 0, window.innerWidth - rect.width)
      const y = clamp((e.clientY || 0) - offsetY, 0, window.innerHeight - rect.height)
      btn.style.left = `${x}px`
      btn.style.top = `${y}px`
      btn.style.right = ""
      btn.style.bottom = ""
    }

    function stop() {
      if (!dragging) return
      dragging = false
      document.removeEventListener("pointermove", onMove, true)
      document.removeEventListener("pointerup", stop, true)
      const rect = btn.getBoundingClientRect()
      try {
        chrome.storage.local.set({ [POS_KEY]: { x: Math.round(rect.left), y: Math.round(rect.top) } })
      } catch {}
    }

    btn.addEventListener(
      "pointerdown",
      (e) => {
        e.preventDefault()
        e.stopPropagation()
        const rect = btn.getBoundingClientRect()
        offsetX = (e.clientX || 0) - rect.left
        offsetY = (e.clientY || 0) - rect.top
        downX = e.clientX || 0
        downY = e.clientY || 0
        dragging = true
        document.addEventListener("pointermove", onMove, true)
        document.addEventListener("pointerup", stop, true)
      },
      true
    )

    btn.addEventListener(
      "click",
      (e) => {
        // Ignore clicks that were actually drags.
        const dist = Math.abs((e.clientX || 0) - downX) + Math.abs((e.clientY || 0) - downY)
        if (dist > 6) return
        try {
          chrome.runtime.sendMessage({ type: "TOGGLE_WIDGET" })
        } catch {}
      },
      true
    )

    document.documentElement.appendChild(btn)
  }

  function init() {
    removeLegacyMockButton()
    createLauncher()
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init)
  } else {
    init()
  }

  // In case the legacy script injects later, keep removing it.
  window.addEventListener("load", () => {
    removeLegacyMockButton()
    createLauncher()
  })
})()


