;(() => {
  let active = false

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

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms))
  }

  function getDocumentDimensionsCss() {
    const doc = document.documentElement
    const body = document.body
    const fullHeight = Math.max(
      doc?.scrollHeight || 0,
      body?.scrollHeight || 0,
      doc?.offsetHeight || 0,
      body?.offsetHeight || 0,
      doc?.clientHeight || 0
    )
    const fullWidth = Math.max(
      doc?.scrollWidth || 0,
      body?.scrollWidth || 0,
      doc?.offsetWidth || 0,
      body?.offsetWidth || 0,
      doc?.clientWidth || 0
    )
    return { fullWidthCss: fullWidth, fullHeightCss: fullHeight }
  }

  function sendToBackground(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError
          resolve(res)
        })
      } catch (e) {
        resolve({ ok: false, error: String(e?.message || e) })
      }
    })
  }

  async function captureFullPage() {
    if (active) return
    const gate = policyAllowsCapture()
    if (!gate.ok) {
      try {
        alert(`Glazyr blocked capture: ${gate.reason}`)
      } catch {}
      return
    }

    active = true

    const originalScroll = { x: window.scrollX || 0, y: window.scrollY || 0 }
    const widget = document.getElementById("glazyr-widget-host")
    const widgetPrev = widget
      ? {
          visibility: widget.style.visibility,
          pointerEvents: widget.style.pointerEvents,
        }
      : null

    const docEl = document.documentElement
    const prevScrollBehavior = docEl?.style?.scrollBehavior || ""

    try {
      // Hide the widget so the screenshot captures the page behind it.
      if (widget) {
        widget.style.visibility = "hidden"
        widget.style.pointerEvents = "none"
      }

      if (docEl && docEl.style) docEl.style.scrollBehavior = "auto"

      const { fullHeightCss } = getDocumentDimensionsCss()
      const viewportWidthCss = window.innerWidth || document.documentElement.clientWidth || 0
      const viewportHeightCss = window.innerHeight || document.documentElement.clientHeight || 0

      if (!fullHeightCss || !viewportHeightCss || !viewportWidthCss) {
        await sendToBackground({ type: "FULLPAGE_CAPTURE_ABORT", error: "Page dimensions unavailable." })
        return
      }

      const initRes = await sendToBackground({
        type: "FULLPAGE_CAPTURE_INIT",
        meta: { fullHeightCss, viewportWidthCss, viewportHeightCss },
      })
      const sessionId = initRes?.sessionId
      if (!sessionId) {
        await sendToBackground({ type: "FULLPAGE_CAPTURE_ABORT", error: initRes?.error || "Failed to init capture session." })
        return
      }

      const total = Math.max(1, Math.ceil(fullHeightCss / viewportHeightCss))

      // Start from top for consistent stitching.
      window.scrollTo(0, 0)
      await sleep(200)

      for (let i = 0; i < total; i++) {
        const y = Math.min(i * viewportHeightCss, Math.max(0, fullHeightCss - viewportHeightCss))
        window.scrollTo(0, y)
        // Give layout/paint a moment, especially on heavy pages.
        await sleep(220)

        const stepRes = await sendToBackground({
          type: "FULLPAGE_CAPTURE_GRAB",
          sessionId,
          scrollYCss: y,
          index: i,
          total,
          viewportWidthCss,
          viewportHeightCss,
        })

        if (!stepRes?.ok) {
          await sendToBackground({ type: "FULLPAGE_CAPTURE_ABORT", sessionId, error: stepRes?.error || "Capture step failed." })
          return
        }
      }

      const doneRes = await sendToBackground({ type: "FULLPAGE_CAPTURE_COMPLETE", sessionId })
      if (!doneRes?.ok) {
        await sendToBackground({ type: "FULLPAGE_CAPTURE_ABORT", sessionId, error: doneRes?.error || "Stitching failed." })
        return
      }
    } finally {
      // Restore state
      try {
        if (docEl && docEl.style) docEl.style.scrollBehavior = prevScrollBehavior
      } catch {}
      try {
        window.scrollTo(originalScroll.x, originalScroll.y)
      } catch {}
      try {
        if (widget && widgetPrev) {
          widget.style.visibility = widgetPrev.visibility
          widget.style.pointerEvents = widgetPrev.pointerEvents
        }
      } catch {}
      active = false
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "BEGIN_FULLPAGE_CAPTURE") {
      captureFullPage()
        .then(() => sendResponse?.({ ok: true }))
        .catch((e) => sendResponse?.({ ok: false, error: String(e?.message || e) }))
      return true
    }
  })
})()


