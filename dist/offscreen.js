(() => {
  let stream = null
  let recorder = null
  let chunks = []
  let mimeType = "audio/webm"

  function pickMimeType() {
    if (typeof MediaRecorder === "undefined") return "audio/webm"
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) return "audio/webm;codecs=opus"
    if (MediaRecorder.isTypeSupported("audio/webm")) return "audio/webm"
    if (MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")) return "audio/ogg;codecs=opus"
    return "audio/webm"
  }

  async function startRecording() {
    if (recorder) return
    mimeType = pickMimeType()
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    recorder = new MediaRecorder(stream, { mimeType })
    chunks = []

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data)
    }

    recorder.start()
  }

  async function stopRecordingAndReturnAudio() {
    if (!recorder) throw new Error("Not recording.")

    const localRecorder = recorder
    const localStream = stream
    recorder = null
    stream = null

    const result = await new Promise((resolve, reject) => {
      localRecorder.onstop = async () => {
        try {
          const blob = new Blob(chunks, { type: mimeType })
          const audio = await blob.arrayBuffer()
          resolve({ audio, mimeType: blob.type || mimeType })
        } catch (e) {
          reject(e)
        }
      }
      try {
        localRecorder.stop()
      } catch (e) {
        reject(e)
      }
    })

    chunks = []
    try {
      localStream?.getTracks?.().forEach((t) => t.stop())
    } catch {}

    return result
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "OFFSCREEN_RECORD_START") {
      startRecording()
        .then(() => sendResponse?.({ ok: true }))
        .catch((e) => sendResponse?.({ ok: false, error: String(e?.message || e) }))
      return true
    }

    if (msg?.type === "OFFSCREEN_RECORD_STOP") {
      stopRecordingAndReturnAudio()
        .then((res) => {
          chrome.runtime.sendMessage({ type: "OFFSCREEN_AUDIO_READY", audio: res.audio, mimeType: res.mimeType })
          sendResponse?.({ ok: true })
        })
        .catch((e) => sendResponse?.({ ok: false, error: String(e?.message || e) }))
      return true
    }
  })
})()


