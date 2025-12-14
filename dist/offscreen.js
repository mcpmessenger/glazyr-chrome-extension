(() => {
  let stream = null
  let recorder = null
  let chunks = []
  let mimeType = "audio/webm"
  let recordingStartTime = null

  const stitchSessions = new Map()

  async function dataUrlToBlob(dataUrl) {
    const res = await fetch(dataUrl)
    return await res.blob()
  }

  async function blobToDataUrl(blob) {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(reader.error)
      reader.onload = () => resolve(reader.result)
      reader.readAsDataURL(blob)
    })
  }

  async function stitchBegin(sessionId, meta) {
    const fullHeightCss = Number(meta?.fullHeightCss || 0)
    const viewportWidthCss = Number(meta?.viewportWidthCss || 0)
    const viewportHeightCss = Number(meta?.viewportHeightCss || 0)
    if (!sessionId) throw new Error("Missing sessionId.")
    if (!fullHeightCss || !viewportWidthCss || !viewportHeightCss) throw new Error("Invalid stitch metadata.")

    stitchSessions.set(sessionId, {
      meta: { fullHeightCss, viewportWidthCss, viewportHeightCss },
      canvas: null,
      ctx: null,
      scale: 1,
      fullHeightPx: 0,
      widthPx: 0,
    })
  }

  async function stitchAppend(sessionId, dataUrl, scrollYCss) {
    const s = stitchSessions.get(sessionId)
    if (!s) throw new Error("Unknown stitch session.")
    if (!dataUrl) throw new Error("Missing dataUrl.")

    const blob = await dataUrlToBlob(dataUrl)
    const bitmap = await createImageBitmap(blob)
    try {
      if (!s.canvas) {
        // Derive scale from bitmap width vs viewport CSS width.
        s.scale = (bitmap.width || 1) / (s.meta.viewportWidthCss || 1)
        s.fullHeightPx = Math.max(1, Math.round((s.meta.fullHeightCss || 1) * s.scale))
        s.widthPx = Math.max(1, bitmap.width || 1)

        s.canvas = new OffscreenCanvas(s.widthPx, s.fullHeightPx)
        s.ctx = s.canvas.getContext("2d")
        if (!s.ctx) throw new Error("No 2D context available for stitching.")

        // Fill background white to avoid black transparency in JPEG exports.
        s.ctx.fillStyle = "#ffffff"
        s.ctx.fillRect(0, 0, s.widthPx, s.fullHeightPx)
      }

      const yPx = Math.max(0, Math.round(Number(scrollYCss || 0) * (s.scale || 1)))
      s.ctx.drawImage(bitmap, 0, yPx)
    } finally {
      try {
        bitmap.close?.()
      } catch {}
    }
  }

  async function stitchFinish(sessionId, output) {
    const s = stitchSessions.get(sessionId)
    if (!s) throw new Error("Unknown stitch session.")
    if (!s.canvas) throw new Error("No frames captured for stitching.")

    const type = String(output?.type || "image/jpeg")
    const quality = typeof output?.quality === "number" ? output.quality : 0.92
    const blob = await s.canvas.convertToBlob({ type, quality })
    const dataUrl = await blobToDataUrl(blob)

    stitchSessions.delete(sessionId)
    return { dataUrl, type, width: s.widthPx, height: s.fullHeightPx }
  }

  async function stitchAbort(sessionId) {
    if (!sessionId) return
    stitchSessions.delete(sessionId)
  }

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
    recordingStartTime = Date.now()

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunks.push(e.data)
        console.log("Audio chunk received:", e.data.size, "bytes, total chunks:", chunks.length)
      }
    }

    // Use a timeslice so we reliably get data chunks even for short recordings.
    recorder.start(250)
    console.log("Recording started, mimeType:", mimeType)
  }

  async function stopRecordingAndReturnAudio() {
    if (!recorder) throw new Error("Not recording.")

    // Check recording duration
    const recordingDuration = recordingStartTime ? Date.now() - recordingStartTime : 0
    if (recordingDuration < 500) {
      console.warn("Recording stopped too quickly:", recordingDuration, "ms")
    }

    const localRecorder = recorder
    const localStream = stream
    const localChunks = [...chunks] // Copy chunks before clearing
    recorder = null
    stream = null
    recordingStartTime = null

    const result = await new Promise((resolve, reject) => {
      localRecorder.onstop = async () => {
        try {
          console.log("Recording stopped, chunks:", localChunks.length, "total size:", localChunks.reduce((sum, c) => sum + (c.size || 0), 0), "bytes")
          
          // Check if we have any chunks
          if (!localChunks || localChunks.length === 0) {
            reject(new Error("No audio data recorded. Please record for at least 1-2 seconds."))
            return
          }

          const blob = new Blob(localChunks, { type: mimeType })
          
          // Check if blob is empty
          if (!blob || blob.size === 0) {
            reject(new Error("Recorded audio was empty. Please try recording again."))
            return
          }

          console.log("Audio blob created:", blob.size, "bytes, type:", blob.type)

          const audioBuf = await blob.arrayBuffer()
          
          // Check if arrayBuffer is empty
          if (!audioBuf || audioBuf.byteLength === 0) {
            reject(new Error("No audio bytes captured. Please try recording again."))
            return
          }

          const audioBytes = new Uint8Array(audioBuf)
          console.log("Audio bytes ready:", audioBytes.length, "bytes")
          resolve({ audioBytes, mimeType: blob.type || mimeType })
        } catch (e) {
          console.error("Error processing audio:", e)
          reject(e)
        }
      }
      try {
        // Flush any pending data before stopping.
        try {
          localRecorder.requestData?.()
        } catch {}
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
          chrome.runtime.sendMessage({ type: "OFFSCREEN_AUDIO_READY", audioBytes: res.audioBytes, mimeType: res.mimeType })
          sendResponse?.({ ok: true })
        })
        .catch((e) => sendResponse?.({ ok: false, error: String(e?.message || e) }))
      return true
    }

    if (msg?.type === "OFFSCREEN_STITCH_BEGIN") {
      stitchBegin(String(msg.sessionId || ""), msg.meta)
        .then(() => sendResponse?.({ ok: true }))
        .catch((e) => sendResponse?.({ ok: false, error: String(e?.message || e) }))
      return true
    }

    if (msg?.type === "OFFSCREEN_STITCH_APPEND") {
      stitchAppend(String(msg.sessionId || ""), String(msg.dataUrl || ""), msg.scrollYCss)
        .then(() => sendResponse?.({ ok: true }))
        .catch((e) => sendResponse?.({ ok: false, error: String(e?.message || e) }))
      return true
    }

    if (msg?.type === "OFFSCREEN_STITCH_FINISH") {
      stitchFinish(String(msg.sessionId || ""), msg.output)
        .then((res) => sendResponse?.({ ok: true, ...res }))
        .catch((e) => sendResponse?.({ ok: false, error: String(e?.message || e) }))
      return true
    }

    if (msg?.type === "OFFSCREEN_STITCH_ABORT") {
      stitchAbort(String(msg.sessionId || ""))
        .then(() => sendResponse?.({ ok: true }))
        .catch(() => sendResponse?.({ ok: true }))
      return true
    }
  })
})()


