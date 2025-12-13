(()=>{"use strict";function e(){const e=window.location.href,t=document.title,o=document.body?document.body.innerText.substring(0,5e3):"";chrome.runtime.sendMessage({type:"PAGE_CONTEXT",url:e,title:t,text:o},e=>{chrome.runtime.lastError?console.error("Error sending message:",chrome.runtime.lastError.message):console.log("Context sent to background:",e)})}function t(e){const t=e.target;let o={};if("INPUT"===t.tagName||"TEXTAREA"===t.tagName){const e=t;o={type:"INPUT_CHANGE",elementType:t.tagName,name:e.name||e.id,value:e.value,timestamp:Date.now()}}else if("FORM"===t.tagName&&"submit"===e.type){const e=t,n={};new FormData(e).forEach((e,t)=>{n[t]=e.toString()}),o={type:"FORM_SUBMIT",formId:e.id||e.name||"unnamed_form",formData:n,timestamp:Date.now()}}else"click"===e.type&&(o={type:"CLICK_EVENT",selector:t.tagName+(t.id?`#${t.id}`:"")+(t.className?`.${t.className.split(" ")[0]}`:""),timestamp:Date.now()});Object.keys(o).length>0&&(chrome.runtime.sendMessage({type:"USER_INPUT",details:o}),console.log("User input captured and sent:",o))}console.log("Glazyr Content Script injected."),"complete"===document.readyState||"interactive"===document.readyState?e():window.addEventListener("load",e),document.addEventListener("input",t,!0),document.addEventListener("submit",t,!0),document.addEventListener("click",t,!0),chrome.runtime.onMessage.addListener((e,t,o)=>{if("EXECUTE_ACTION"===e.type){const{action:t,selector:n,requestId:r,taskId:a,stepId:s,ts:c}=e;try{const e=window.__glazyrPolicy||{},i=String(t||"").toLowerCase();if(e.killSwitchEngaged)return console.warn("Glazyr policy: kill switch engaged; blocking action."),o({status:"blocked",error:"Kill switch engaged"}),!0;if("observe"===e.agentMode&&("click"===i||"type"===i||"navigate"===i||"submit"===i))return console.warn("Glazyr policy: observe mode; blocking action."),o({status:"blocked",error:"Observe mode"}),!0}catch{}console.log(`Executing action: ${t} on selector: ${n}`);try{const e=document.querySelector(n);e?("click"===t&&(e.click(),console.log(`Clicked element: ${n}`)),chrome.runtime.sendMessage({type:"ACTION_EXECUTED",action:t,selector:n,status:"success",requestId:r,taskId:a,stepId:s,ts:c})):console.error(`Element not found for selector: ${n}`)}catch(e){console.error(`Error executing action ${t}:`,e)}return o({status:"Action execution attempt complete"}),!0}}),window.addEventListener("load",function(){const e=document.createElement("button");e.id="mock-button",e.textContent="Glazyr Mock Button",e.style.position="fixed",e.style.bottom="10px",e.style.right="10px",e.style.zIndex="99999",e.style.padding="10px",e.style.backgroundColor="lightblue",e.onclick=()=>{alert("Glazyr Mock Button Clicked!"),console.log("Glazyr Mock Button Clicked!")},document.body.appendChild(e)})})();

;(() => {
  const WEB_SOURCE = "glazyr-web"
  const EXT_SOURCE = "glazyr-extension"
  const CONTROL_PLANE_CONFIG_KEY = "glazyrControlPlaneConfig"
  const KILLSWITCH_KEY = "glazyrKillSwitch"

  let lastWebSeen = 0
  let policyState = {
    policyEnforced: true,
    killSwitchEngaged: false,
    allowedDomainsCount: 0,
    agentMode: "observe",
  }
  let policyDetails = {
    killSwitchEngaged: false,
    agentMode: "observe",
    allowedDomains: /** @type {string[]} */ ([]),
    disallowedActions: /** @type {string[]} */ ([]),
  }

  function updatePolicyStateFromStorage(res) {
    const cfg = res?.[CONTROL_PLANE_CONFIG_KEY]
    const ks = res?.[KILLSWITCH_KEY]
    const allowedDomains = Array.isArray(cfg?.safety?.allowedDomains) ? cfg.safety.allowedDomains : []
    const disallowedActions = Array.isArray(cfg?.safety?.disallowedActions) ? cfg.safety.disallowedActions : []
    const agentMode =
      (cfg?.agentMode === "assist" || cfg?.agentMode === "automate" || cfg?.agentMode === "observe") ? cfg.agentMode : "observe"
    const killSwitchEngaged = !!(ks?.engaged || cfg?.killSwitchEngaged)

    policyState = {
      policyEnforced: true,
      killSwitchEngaged,
      allowedDomainsCount: allowedDomains.length,
      agentMode,
    }
    policyDetails = {
      killSwitchEngaged,
      agentMode,
      allowedDomains,
      disallowedActions,
    }
    // Also expose it for other injected scripts running in the same page context.
    try {
      window.__glazyrPolicy = { ...policyDetails, ...policyState }
    } catch {
      // ignore
    }
  }

  function refreshPolicyState() {
    try {
      chrome.storage.local.get([CONTROL_PLANE_CONFIG_KEY, KILLSWITCH_KEY], (res) => {
        updatePolicyStateFromStorage(res)
      })
    } catch {
      // ignore
    }
  }

  function post(msg) {
    try {
      window.postMessage(msg, "*")
    } catch {
      // ignore
    }
  }

  function guessBrowserType() {
    const ua = String(navigator.userAgent || "")
    if (ua.includes("Edg/")) return "edge"
    if (ua.includes("Brave") || (navigator.brave && typeof navigator.brave.isBrave === "function")) return "brave"
    if (ua.includes("Chrome/")) return "chrome"
    return "other"
  }

  function getPermissionsList() {
    try {
      const m = chrome.runtime.getManifest()
      const perms = [...(m.permissions || []), ...(m.host_permissions || [])]
      return Array.from(new Set(perms.map((p) => String(p))))
    } catch {
      return []
    }
  }

  function sendStatus(extra) {
    const now = Date.now()
    const payload = {
      connected: true,
      browserType: guessBrowserType(),
      permissionsGranted: getPermissionsList(),
      lastHeartbeat: now,
      ...policyState,
      ...(extra || {}),
    }
    post({ source: EXT_SOURCE, type: "glazyr:status", ts: now, payload })
  }

  function onWindowMessage(ev) {
    const data = ev?.data
    if (!data || typeof data !== "object") return
    if (data.source !== WEB_SOURCE) return

    lastWebSeen = Date.now()

    if (data.type === "glazyr:ping") {
      post({ source: EXT_SOURCE, type: "glazyr:pong", requestId: data.requestId, ts: Date.now() })
      refreshPolicyState()
      sendStatus()
      return
    }

    if (data.type === "glazyr:config:update" && data.payload) {
      try {
        chrome.storage.local.set({ [CONTROL_PLANE_CONFIG_KEY]: data.payload })
      } catch {
        // ignore
      }
      refreshPolicyState()
      return
    }

    if (data.type === "glazyr:killswitch" && data.payload) {
      try {
        chrome.storage.local.set({ [KILLSWITCH_KEY]: data.payload })
      } catch {
        // ignore
      }
      refreshPolicyState()
      return
    }
  }

  window.addEventListener("message", onWindowMessage)

  // Track policy changes even if the web app isn't actively sending messages.
  refreshPolicyState()
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return
      if (changes?.[CONTROL_PLANE_CONFIG_KEY] || changes?.[KILLSWITCH_KEY]) refreshPolicyState()
    })
  } catch {
    // ignore
  }

  // Periodic status updates, but only after the control plane has been seen.
  window.setInterval(() => {
    if (!lastWebSeen) return
    if (Date.now() - lastWebSeen > 30_000) return
    sendStatus()
  }, 5_000)
})()