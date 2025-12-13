(() => {
  const logEl = document.getElementById("log")
  const btn = document.getElementById("enable")

  function log(msg) {
    if (logEl) logEl.textContent = String(msg)
  }

  async function enable() {
    log("Requesting microphone…")
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      log("Microphone enabled ✅ You can close this tab and use the 🎙 button in the widget.")
      try {
        stream.getTracks().forEach((t) => t.stop())
      } catch {}
    } catch (e) {
      const name = e?.name || "Error"
      const message = e?.message || String(e)
      log(`${name}: ${message}`)
    }
  }

  if (btn) btn.addEventListener("click", enable)
})()


