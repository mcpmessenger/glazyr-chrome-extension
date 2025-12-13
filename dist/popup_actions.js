(() => {
  function startFramedScreenshot() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs?.[0]?.id
      if (!tabId) return
      chrome.tabs.sendMessage(tabId, { type: "START_CROP_CAPTURE" })
    })
  }

  function wire() {
    const btn = document.getElementById("glazyr-framed-shot")
    if (btn) btn.addEventListener("click", startFramedScreenshot)
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire)
  } else {
    wire()
  }
})()


