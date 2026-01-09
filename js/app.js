// Kid Telepresence (simple, single-page, no roles)
// How it works:
// - Both devices open the same page and enter the same room code
// - One device becomes "host" automatically (first to claim <room>-host ID)
// - The other becomes "guest" and calls the host
// - Both send+receive audio/video in a single PeerJS call

const $ = (id) => document.getElementById(id);

const roomInput = $("roomInput");
const startBtn = $("startBtn");
const muteMicBtn = $("muteMicBtn");
const switchCamBtn = $("switchCamBtn");
const flipBtn = $("flipBtn");
const flipRemoteBtn = $("flipRemoteBtn");
const connectBtn = $("connectBtn");
const hangupBtn = $("hangupBtn");
const localVideo = $("localVideo");
const remoteVideo = $("remoteVideo");
const videoStage = $("videoStage");
const remoteFsBtn = $("remoteFsBtn");
const statusPill = $("status");
const connPill = $("connPill");
const logEl = $("log");
const clearLogsBtn = $("clearLogsBtn");

const textInput = $("textInput");
const sendTextBtn = $("sendTextBtn");

// micro:bit Live Link UI
const mbStatus = $("mbStatus");
const mbConnectBtn = $("mbConnectBtn");
const mbDisconnectBtn = $("mbDisconnectBtn");
const mbSendTestBtn = $("mbSendTestBtn");
const mbBridgeOnBtn = $("mbBridgeOnBtn");
const mbBridgeOffBtn = $("mbBridgeOffBtn");
const mbMuteMbBtn = $("mbMuteMbBtn");

// Disable controls until data channel is open
function enableControls(on){
  const disabled = !on;
  document.querySelectorAll('[data-dir], [data-btn]').forEach(b => {
    b.disabled = disabled;
    b.classList.toggle('disabled', disabled);
  });
  if (sendTextBtn) sendTextBtn.disabled = disabled;
  if (textInput) textInput.disabled = disabled;
}

enableControls(false);

// ---- Remote fullscreen ----
function updateFsButton(){
  if (!remoteFsBtn) return;
  const inFs = !!document.fullscreenElement;
  remoteFsBtn.innerHTML = inFs
    ? '<span class="btn-icon">⛶</span> Exit fullscreen'
    : '<span class="btn-icon">⛶</span> Remote fullscreen';
}

async function toggleRemoteFullscreen(){
  if (!videoStage) return;
  try{
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await videoStage.requestFullscreen();
    }
  } catch (e){
    log("Fullscreen failed:", e?.message || String(e));
  }
  updateFsButton();
}

remoteFsBtn?.addEventListener("click", toggleRemoteFullscreen);
document.addEventListener("fullscreenchange", updateFsButton);
updateFsButton();

// ---- Local thumbnail: smaller + draggable ----
(function initThumbDrag(){
  const el = localVideo;
  const stage = videoStage;
  if (!el || !stage) return;

  el.style.touchAction = "none";
  el.style.cursor = "grab";

  let dragging = false;
  let startX = 0, startY = 0;
  let offsetX = 0, offsetY = 0;

  function clamp(v, min, max){ return Math.max(min, Math.min(max, v)); }

  el.addEventListener("pointerdown", (ev) => {
    dragging = true;
    el.setPointerCapture(ev.pointerId);
    el.style.cursor = "grabbing";

    const stageRect = stage.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    startX = ev.clientX;
    startY = ev.clientY;

    // Current top-left relative to stage
    offsetX = elRect.left - stageRect.left;
    offsetY = elRect.top - stageRect.top;

    // switch from right/bottom anchoring to left/top anchoring
    el.style.right = "auto";
    el.style.bottom = "auto";
    el.style.left = offsetX + "px";
    el.style.top = offsetY + "px";
  });

  el.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    const stageRect = stage.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();

    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;

    const newLeft = offsetX + dx;
    const newTop  = offsetY + dy;

    const maxLeft = stageRect.width - elRect.width;
    const maxTop  = stageRect.height - elRect.height;

    el.style.left = clamp(newLeft, 8, maxLeft - 8) + "px";
    el.style.top  = clamp(newTop,  8, maxTop - 8) + "px";
  });

  function endDrag(){
    if (!dragging) return;
    dragging = false;
    el.style.cursor = "grab";
  }
  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);
})();


function setStatus(t){
  // Keep the chip-dot span intact; only update the text span.
  if (!statusPill) return;
  const spans = statusPill.querySelectorAll("span");
  if (spans && spans.length >= 2) spans[1].textContent = t;
  else statusPill.textContent = t;
}

function setConnStatus(text, connected=false){
  if (!connPill) return;
  const spans = connPill.querySelectorAll("span");
  if (spans && spans.length >= 2) spans[1].textContent = text;
  else connPill.textContent = text;
  connPill.classList.toggle("connected", !!connected);
}

function _fmt(v){
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
function logEvent({dir="SYS", src="APP", msg=""} = {}){
  const logEl = $("log");
  const line = `[${dir}][${src}] ${msg}`;
  if (logEl) logEl.textContent += line + "\n";
  // keep log scrolled to bottom unless user has scrolled up a lot
  if (logEl && (logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight) < 40) {
    logEl.scrollTop = logEl.scrollHeight;
  }
}
// Backwards-compatible helpers
function log(...args){ logEvent({dir:"SYS", src:"APP", msg: args.map(_fmt).join(" ")}); }
function logRx(...args){ logEvent({dir:"RX", src:"PEER", msg: args.map(_fmt).join(" ")}); }

clearLogsBtn?.addEventListener("click", () => {
  if (logEl) logEl.textContent = "";
  // Also clear pending ACK diagnostics so log doesn't immediately refill with stale timeouts.
  _pending.clear();
  log("Logs cleared.");
});

function setDataConn(conn){
  if (!conn) return;
  try { dataConn?.close(); } catch {}
  dataConn = conn;

  conn.on("open", () => {
    log("Data channel open ✅");
    enableControls(true);
    setConnStatus("Connected", true);
  });
  conn.on("data", (msg) => {
    // ACK handler
    if (msg && typeof msg === "object" && msg.type === "ack" && msg.id){
      if (_pending.has(msg.id)){
        _pending.delete(msg.id);
        logEvent({dir:"RX", src:"ACK", msg: "ack for " + msg.id});
      } else {
        logEvent({dir:"RX", src:"ACK", msg: "late/unknown ack " + msg.id});
      }
      return;
    }

    // Normal messages: log + reply ACK
    if (msg && typeof msg === "object"){
      const src = (msg.type === "cmd") ? "DPAD" :
                  (msg.type === "btn") ? "BUTTONS" :
                  (msg.type === "text") ? "TEXT" : "PEER";
      logEvent({dir:"RX", src, msg: _fmt(msg)});
      markPeerActivity();

      // Forward received commands to micro:bit if bridge enabled
      if (mbBridgeEnabled) forwardToMicrobitFromPeer(msg);

      // ACK back for anything that has _id
      if (msg._id){
        try{ conn.send({ type:"ack", id: msg._id }); }catch{}
      }
    } else {
      logEvent({dir:"RX", src:"PEER", msg: _fmt(msg)});
    }
  });
  conn.on("close", () => {
    safetyStop("peer disconnect");
    log("Data channel closed");
    enableControls(false);
    // If media is still up, we may still be "connected" video-wise, so don't force red.
    if (!call) setConnStatus("Not connected", false);
  });
  conn.on("error", (e) => {
    log("Data channel error:", e?.message || String(e));
    if (!call) setConnStatus("Not connected", false);
  });
}


// ---- DataChannel messaging + ACK ----
let _seq = 1;
const _pending = new Map(); // id -> {t, msg}


function sendMsg(obj){
  const id = obj && (obj._id || obj.id) || ("m" + Date.now() + "-" + Math.random().toString(16).slice(2));
  const msg = Object.assign({}, obj, { _id: id });
  const src = (obj && obj._src) || (
    msg.type === "cmd" ? "DPAD" :
    msg.type === "btn" ? "BUTTONS" :
    msg.type === "text" ? "TEXT" :
    msg.type === "ack" ? "ACK" : "APP"
  );

  if (!dataConn || !dataConn.open){
    logEvent({dir:"TX", src, msg: "skipped (data channel not open): " + _fmt(msg)});
    return null;
  }
  try{
    dataConn.send(msg);
    logEvent({dir:"TX", src, msg: _fmt(msg)});
    _pending.set(id, { t: Date.now(), msg, tries: 1 });
    return id;
  } catch(e){
    logEvent({dir:"SYS", src:"APP", msg: "Send failed: " + (e && e.message ? e.message : e)});
    return null;
  }
}
setInterval(() => {
  const now = Date.now();
  for (const [id, info] of _pending){
    if (now - info.t > 1500){
      log("No ACK (yet):", id, info.msg?.type || "");
      _pending.delete(id);
    }
  }
}, 750);

let localStream = null;
let peer = null;
let call = null;
let dataConn = null;

// micro:bit BLE UART bridge
let microbit = null;
let mbBridgeEnabled = false;
    stopSafetyWatchdog();
// ---- Safety: auto STOP on disconnect / inactivity ----
let _lastPeerControlMs = Date.now();
let _safetyTimer = null;
const SAFETY_INACTIVITY_MS = 900;   // no commands for this long -> STOP
const SAFETY_CHECK_MS = 250;

function markPeerActivity(){
  _lastPeerControlMs = Date.now();
}

async function safetyStop(reason=""){
  // Only meaningful when we are bridging to a micro:bit robot
  if (!(mbBridgeEnabled && microbit && microbit.connected)) {
    // still log the event for visibility
    logEvent({dir:"SYS", src:"SAFETY", msg:`auto-stop (${reason}) skipped (bridge off or micro:bit not connected)`});
    return;
  }
  try{
    const line = "CMD STOP 1";
    await microbit.sendLine(line);
    logEvent({dir:"TX", src:"MB", msg: `${line}  // auto-stop: ${reason}`});
  } catch(e){
    logEvent({dir:"SYS", src:"SAFETY", msg:`auto-stop failed: ${(e?.message||e)}`});
  }
}

function startSafetyWatchdog(){
  if (_safetyTimer) return;
  _lastPeerControlMs = Date.now();
  _safetyTimer = setInterval(() => {
    const idle = Date.now() - _lastPeerControlMs;
    if (idle > SAFETY_INACTIVITY_MS){
      // trigger once per inactivity window
      _lastPeerControlMs = Date.now();
      safetyStop("inactivity");
    }
  }, SAFETY_CHECK_MS);
}

function stopSafetyWatchdog(){
  if (_safetyTimer){
    clearInterval(_safetyTimer);
    _safetyTimer = null;
  }
}

let isHost = false;
let hostId = null;

// Camera switching / mirroring
let videoDevices = [];
let currentDeviceIndex = 0;
let currentFacing = "user"; // user | environment
let isMirrored = true;
let isRemoteFlipped = false;
let isMicMuted = false;

function setMicMuted(on){
  isMicMuted = !!on;
  const tracks = localStream?.getAudioTracks?.() || [];
  tracks.forEach(t => { t.enabled = !isMicMuted; });
  if (muteMicBtn){
    muteMicBtn.textContent = isMicMuted ? "Unmute mic 🎙️" : "Mute mic 🔇";
    muteMicBtn.classList.toggle("stop", isMicMuted);
  }
}

function setMirror(on){
  isMirrored = !!on;
  if (!localVideo) return;
  localVideo.classList.toggle("mirrored", isMirrored);
  if (flipBtn) flipBtn.textContent = isMirrored ? "Unmirror 🪞" : "Mirror self 🪞";
}

function setRemoteFlip(on){
  isRemoteFlipped = !!on;
  if (!remoteVideo) return;
  remoteVideo.classList.toggle("mirrored", isRemoteFlipped);
  if (flipRemoteBtn) flipRemoteBtn.textContent = isRemoteFlipped ? "Unflip remote ↔️" : "Flip remote ↔️";
}

async function refreshVideoDevices(){
  try{
    const devices = await navigator.mediaDevices.enumerateDevices();
    videoDevices = devices.filter(d => d.kind === "videoinput");
    // Keep index in range
    if (videoDevices.length && currentDeviceIndex >= videoDevices.length) currentDeviceIndex = 0;
  }catch(e){
    // Some browsers require permissions before enumerateDevices returns labels
    videoDevices = [];
  }
}

async function replaceOutgoingVideoTrack(newTrack){
  if (!localStream) return;
  const old = localStream.getVideoTracks()[0];
  if (old){
    try{ localStream.removeTrack(old); }catch{}
    try{ old.stop(); }catch{}
  }
  localStream.addTrack(newTrack);

  // If we're in a call, replace the sender's track without renegotiation.
  const pc = call?.peerConnection;
  const sender = pc?.getSenders?.().find(s => s.track && s.track.kind === "video");
  if (sender?.replaceTrack){
    try{ await sender.replaceTrack(newTrack); }catch(e){ log("replaceTrack failed:", e?.message || String(e)); }
  }
}

async function switchCamera(){
  if (!localStream){
    log("Switch camera: start camera first");
    return;
  }

  setStatus("Switching camera…");
  await refreshVideoDevices();

  try{
    let videoConstraint = null;

    if (videoDevices.length > 1){
      // Cycle actual camera devices when available (desktop + many Androids)
      currentDeviceIndex = (currentDeviceIndex + 1) % videoDevices.length;
      const deviceId = videoDevices[currentDeviceIndex].deviceId;
      videoConstraint = { deviceId: { exact: deviceId } };
      log("Switching to device:", videoDevices[currentDeviceIndex].label || deviceId);
    } else {
      // Fallback: try toggling facingMode (mobile)
      currentFacing = (currentFacing === "user") ? "environment" : "user";
      // Try exact first, then ideal
      videoConstraint = { facingMode: { exact: currentFacing } };
      log("Switching facingMode (exact):", currentFacing);
    }

    let s;
    try{
      s = await navigator.mediaDevices.getUserMedia({ video: videoConstraint, audio: false });
    }catch(e){
      // If facingMode exact fails, retry with ideal
      if (!videoDevices.length){
        log("Exact facingMode failed, retry ideal:", e?.name || "", e?.message || String(e));
        s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: currentFacing } }, audio: false });
      } else {
        throw e;
      }
    }

    const [newTrack] = s.getVideoTracks();
    if (!newTrack) throw new Error("No video track from camera");

    await replaceOutgoingVideoTrack(newTrack);
    // Keep local preview running (same MediaStream object)
    localVideo.srcObject = localStream;
    await localVideo.play().catch(()=>{});

    // Helpful default: mirror for front cam, unmirror for back cam
    if (!videoDevices.length) setMirror(currentFacing === "user");

    setStatus("Camera switched ✅");
    log("Camera switched. Track:", `${newTrack.label || "video"}`);
  } catch (e) {
    log("Switch camera failed:", e?.name || "", e?.message || String(e));
    setStatus("Switch failed ❌");
    alert("Could not switch camera on this device/browser.");
  }
}

function randomId(n=6){
  return Math.random().toString(16).slice(2, 2+n);
}

async function ensureLocalStream(){
  if (localStream) return localStream;
  setStatus("Requesting camera/mic…");
  localStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user" },
    audio: true
  });
  localVideo.srcObject = localStream;
  await localVideo.play().catch(()=>{});
  // Enable camera tools once permissions are granted
  muteMicBtn && (muteMicBtn.disabled = false);
  switchCamBtn && (switchCamBtn.disabled = false);
  flipBtn && (flipBtn.disabled = false);
  // Remote flip is a UI-only transform; enable once app is interactive
  flipRemoteBtn && (flipRemoteBtn.disabled = false);
  await refreshVideoDevices();
  setMirror(true);

  // Default: mic unmuted
  setMicMuted(false);

  // Default: do not flip remote
  setRemoteFlip(false);

  setStatus("Camera ON 🎥");
  log("Local stream tracks:", localStream.getTracks().map(t=>`${t.kind}:${t.readyState}`).join(", "));
  return localStream;
}

function stopLocalMedia(){
  if (!localStream) return;
  try {
    localStream.getTracks().forEach(t => {
      try { t.stop(); } catch {}
    });
  } finally {
    localStream = null;
    if (localVideo) localVideo.srcObject = null;
    // Disable camera tools until user starts again
    muteMicBtn && (muteMicBtn.disabled = true);
    switchCamBtn && (switchCamBtn.disabled = true);
    flipBtn && (flipBtn.disabled = true);
    flipRemoteBtn && (flipRemoteBtn.disabled = true);
  }
}

function cleanupPeer(){
  try { call?.close(); } catch {}
  call = null;
  try { peer?.destroy(); } catch {}
  peer = null;
  isHost = false;
  hostId = null;
  if (remoteVideo) remoteVideo.srcObject = null;
  if (remoteFsBtn) remoteFsBtn.disabled = true;
  // Keep flip state (UI preference) but ensure class is applied consistently
  setRemoteFlip(isRemoteFlipped);
  hangupBtn.style.display = "none";
  setConnStatus("Not connected", false);
}

function attachCallHandlers(c){
  call = c;
  hangupBtn.style.display = "";
  // Data channel and media may connect in either order; show a useful intermediate state.
  setConnStatus("Connecting…", false);

  // --- Data channel robustness ---
  // In practice, the media call and the data connection can open in either order.
  // Some environments also occasionally miss the "connection" event on the host
  // if the guest connects extremely quickly. To make delivery reliable, once we
  // know the remote peer id (from the media call), we proactively try to open a
  // data channel too (it will be deduplicated by our setDataConn()).
  const ensureDataTo = (remotePeerId) => {
    if (!remotePeerId) return;
    if (dataConn && dataConn.open) return;
    if (!peer) return;
    try {
      log("Opening data channel to:", remotePeerId);
      const dc = peer.connect(remotePeerId, { reliable: true });
      setDataConn(dc);
    } catch (e) {
      log("Failed to open data channel:", e?.message || String(e));
    }
  };
  c.on("stream", (remoteStream) => {
    log("Remote stream received:", remoteStream.getTracks().map(t=>`${t.kind}:${t.readyState}`).join(", "));
    remoteVideo.srcObject = remoteStream;
    remoteVideo.play().catch(()=>{});
    // Re-apply remote flip preference after the element starts rendering
    setRemoteFlip(isRemoteFlipped);
    setStatus("Connected ✅");
    setConnStatus("Connected", true);
    if (remoteFsBtn) remoteFsBtn.disabled = false;
  });

  // Once we know who we're connected to, try to ensure a data channel exists.
  // (The peer id is available immediately; no need to wait for stream.)
  ensureDataTo(c.peer);
  c.on("close", () => {
    safetyStop("call closed");
    log("Call closed");
    setStatus("Disconnected");
    setConnStatus("Not connected", false);
    if (remoteVideo) remoteVideo.srcObject = null;
    if (remoteFsBtn) remoteFsBtn.disabled = true;
    hangupBtn.style.display = "none";
  });
  c.on("error", (e) => {
    log("Call error:", e?.message || String(e));
    setStatus("Call error ❌");
  });
}

async function connect(){
  const roomCode = (roomInput.value || "").trim();
  if (!roomCode){
    alert("Enter a room code (same on both devices).");
    return;
  }

  await ensureLocalStream();

  // Reset any previous connection
  cleanupPeer();

  hostId = `${encodeURIComponent(roomCode)}-host`;
  setStatus("Connecting…");
  setConnStatus("Connecting…", false);
  log("Room:", roomCode, "Host ID:", hostId);

  // Try to become host first (no role selection).
  // If the ID is already taken, we'll become guest automatically.
  let triedGuest = false;

  function becomeGuest(){
    if (triedGuest) return;
    triedGuest = true;

    const guestId = `${encodeURIComponent(roomCode)}-guest-${randomId()}`;
    log("Host already exists -> becoming guest:", guestId);
    peer = new Peer(guestId, { debug: 2 });

    peer.on("open", (id) => {
      log("Peer open (guest):", id);
      setStatus("Calling other device…");
      setConnStatus("Calling…", false);
      const c = peer.call(hostId, localStream);
      attachCallHandlers(c);
      // Data channel to host
      log("Opening data channel to host…");
      const dc = peer.connect(hostId, { reliable: true });
      dc.on("error", (e) => log("Data channel (guest) error:", e?.message || String(e)));
      dc.on("close", () => log("Data channel (guest) closed"));
      setDataConn(dc);
    });

    peer.on("connection", (conn) => {
    log("Incoming data connection from:", conn.peer);
    setDataConn(conn);
  });

  peer.on("call", (incoming) => {
      // In case both sides race, still answer.
      log("Incoming call (guest) from:", incoming.peer);
      incoming.answer(localStream);
      attachCallHandlers(incoming);
    });

    peer.on("error", (e) => {
      log("Peer error (guest):", e?.type || "", e?.message || String(e));
      setStatus("Error ❌");
    });
  }

  peer = new Peer(hostId, { debug: 2 });

  peer.on("open", (id) => {
    isHost = true;
    log("Peer open (host):", id);
    setStatus("Waiting for other device…");
    setConnStatus("Waiting…", false);
  });

  peer.on("call", (incoming) => {
    log("Incoming call (host) from:", incoming.peer);
    incoming.answer(localStream);
    attachCallHandlers(incoming);
  });

  peer.on("connection", (conn) => {
    log("Incoming data connection (host) from:", conn.peer);
    setDataConn(conn);
  });

  peer.on("error", (e) => {
    log("Peer error (host attempt):", e?.type || "", e?.message || String(e));
    if (e?.type === "unavailable-id"){
      // Host already taken -> guest
      try { peer.destroy(); } catch {}
      peer = null;
      becomeGuest();
    } else {
      setStatus("Error ❌");
    }
  });
}

startBtn?.addEventListener("click", async () => {
  try {
    await ensureLocalStream();
  } catch (e) {
    log("getUserMedia failed:", e?.name || "", e?.message || String(e));
    setStatus("Permission blocked ❌");
    alert("Camera/mic permission blocked or not supported.\n\nTip: Use HTTPS (GitHub Pages) and allow permissions.");
  }
});

connectBtn?.addEventListener("click", async () => {
  try {
    await connect();
  } catch (e) {
    log("Connect failed:", e?.message || String(e));
    setStatus("Connect failed ❌");
  }
});

hangupBtn?.addEventListener("click", () => {
  cleanupPeer();
  stopLocalMedia();
  enableControls(false);
  setStatus("Idle");
});

switchCamBtn?.addEventListener("click", () => {
  switchCamera();
});

flipBtn?.addEventListener("click", () => {
  setMirror(!isMirrored);
  log("Mirror:", isMirrored ? "ON" : "OFF");
});

flipRemoteBtn?.addEventListener("click", () => {
  setRemoteFlip(!isRemoteFlipped);
  log("Remote flip:", isRemoteFlipped ? "ON" : "OFF");
});

muteMicBtn?.addEventListener("click", () => {
  if (!localStream){
    log("Mute mic: start camera first");
    return;
  }
  setMicMuted(!isMicMuted);
  log("Mic:", isMicMuted ? "MUTED" : "ON");
});


sendTextBtn?.addEventListener("click", () => {
  const t = (textInput?.value || "").trim();
  if (!t) return;
  const mid = sendMsg({ type: "text", text: t, _src: "TEXT" });
  if (!mid){
    log("Text not sent (data channel not open yet).");
    return;
  }
  log("Text sent:", t, "(id:", mid + ")");
  textInput.value = "";
});

textInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendTextBtn?.click();
});

function bindVirtualControls(){
  // D-pad: send pressed true on down, false on up/leave
  document.querySelectorAll("[data-dir]").forEach((btn) => {
    const cmd = btn.getAttribute("data-dir");
    const down = (e) => { e.preventDefault(); sendMsg({ type: "cmd", cmd, pressed: true, _src: "DPAD" }); };
    const up = (e) => { e.preventDefault(); sendMsg({ type: "cmd", cmd, pressed: false, _src: "DPAD" }); };
    btn.addEventListener("pointerdown", down);
    btn.addEventListener("pointerup", up);
    btn.addEventListener("pointercancel", up);
    btn.addEventListener("pointerleave", up);
  });

  // Buttons: click sends a tap (down then up)
  document.querySelectorAll("[data-btn]").forEach((btn) => {
    const id = btn.getAttribute("data-btn");
    btn.addEventListener("pointerdown", (e) => { e.preventDefault(); sendMsg({ type: "btn", id, pressed: true, _src: "BUTTONS" }); });
    btn.addEventListener("pointerup", (e) => { e.preventDefault(); sendMsg({ type: "btn", id, pressed: false, _src: "BUTTONS" }); });
    btn.addEventListener("pointercancel", (e) => { e.preventDefault(); sendMsg({ type: "btn", id, pressed: false, _src: "BUTTONS" }); });
    btn.addEventListener("pointerleave", (e) => { e.preventDefault(); sendMsg({ type: "btn", id, pressed: false, _src: "BUTTONS" }); });
  });
}

bindVirtualControls();

// Nice default status


// === micro:bit BLE UART (adapted from ble-uart.js) ===
// ble-uart.js
const UART_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class MicrobitUart {
  constructor({ onLog = () => {}, onRx = () => {}, onConnectionChange = () => {} } = {}) {
    this.onLog = onLog;
    this.onRx = onRx;
    this.onConnectionChange = onConnectionChange;
    this.device = null;
    this.server = null;
    this.writeChar = null;
    this.notifyChar = null;
  }

  get connected() {
    return !!(this.device && this.device.gatt && this.device.gatt.connected && this.writeChar);
  }

  async connect() {
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "BBC micro:bit" }],
      optionalServices: [UART_SERVICE],
    });

    this.device.addEventListener("gattserverdisconnected", () => {
      this._clear();
      this.onConnectionChange(false);
    });

    this.server = await this.device.gatt.connect();
    const service = await this.server.getPrimaryService(UART_SERVICE);
    const chars = await service.getCharacteristics();

    this.writeChar =
      chars.find((c) => c.properties.writeWithoutResponse) ||
      chars.find((c) => c.properties.write);

    this.notifyChar = chars.find((c) => c.properties.notify);

    if (this.notifyChar) {
      await this.notifyChar.startNotifications();
      this.notifyChar.addEventListener("characteristicvaluechanged", (e) => {
        const text = new TextDecoder().decode(e.target.value).trim();
        this.onRx(text);
      });
    }

    this.onConnectionChange(true);
  }

  async disconnect() {
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this._clear();
    this.onConnectionChange(false);
  }

  async sendLine(line) {
    const msg = line.endsWith("\n") ? line : line + "\n";
    const data = new TextEncoder().encode(msg);
    for (let i = 0; i < data.length; i += 20) {
      await this.writeChar.writeValueWithoutResponse(data.slice(i, i + 20));
      await sleep(15);
    }
  }

  _clear() {
    this.device = null;
    this.server = null;
    this.writeChar = null;
    this.notifyChar = null;
  }
}


// UI + bridge helpers
function mbSetStatus(text, ok=false){
  if (!mbStatus) return;
  mbStatus.classList.toggle("connected", !!ok);
  const dot = '<span class="status-dot"></span>';
  mbStatus.innerHTML = dot + '<span>' + text + '</span>';
}

function encodeForMicrobit(msg){
  if (!msg || typeof msg !== "object") return "RAW " + _fmt(msg);
  if (msg.type === "cmd"){
    // e.g. CMD RIGHT 1
    return `CMD ${msg.cmd} ${msg.pressed ? 1 : 0}`;
  }
  if (msg.type === "btn"){
    // e.g. BTN A 1
    return `BTN ${msg.id} ${msg.pressed ? 1 : 0}`;
  }
  if (msg.type === "text"){
    return `TXT ${String(msg.text || "").slice(0, 40)}`;
  }
  return `MSG ${msg.type || "unknown"} ${JSON.stringify(msg).slice(0, 60)}`;
}

async function forwardToMicrobitFromPeer(msg){
  if (!microbit || !microbit.connected) {
    logEvent({dir:"SYS", src:"MB", msg:"bridge on but micro:bit not connected"});
    return;
  }
  const line = encodeForMicrobit(msg);
  try{
    await microbit.sendLine(line);
    logEvent({dir:"TX", src:"MB", msg: line});
  } catch(e){
    logEvent({dir:"SYS", src:"MB", msg:"send failed: " + (e?.message || e)});
  }
}

// Setup micro:bit handlers
(function initMicrobit(){
  if (!mbConnectBtn) return;

  microbit = new MicrobitUart({
    onLog: (t) => logEvent({dir:"SYS", src:"MB", msg:String(t)}),
    onRx: (t) => logEvent({dir:"RX", src:"MB", msg:String(t)}),
    onConnectionChange: (ok) => {
      if (!ok) stopSafetyWatchdog();
      mbSetStatus(ok ? "Connected" : "Disconnected", ok);
      mbDisconnectBtn && (mbDisconnectBtn.disabled = !ok);
      mbSendTestBtn && (mbSendTestBtn.disabled = !ok);
      mbBridgeOnBtn && (mbBridgeOnBtn.disabled = !ok);
      mbBridgeOffBtn && (mbBridgeOffBtn.disabled = !ok);
      mbMuteMbBtn && (mbMuteMbBtn.disabled = !ok);
      if (!ok) mbBridgeEnabled = false;
    }
  });

  mbSetStatus("Disconnected", false);

  mbConnectBtn.addEventListener("click", async () => {
    try{
      mbSetStatus("Connecting…", false);
      await microbit.connect();
      logEvent({dir:"SYS", src:"MB", msg:"connected"});
    } catch(e){
      mbSetStatus("Disconnected", false);
      logEvent({dir:"SYS", src:"MB", msg:"connect failed: " + (e?.message || e)});
    }
  });

  mbDisconnectBtn?.addEventListener("click", async () => {
    try{
      await microbit.disconnect();
      logEvent({dir:"SYS", src:"MB", msg:"disconnected"});
    } catch(e){
      logEvent({dir:"SYS", src:"MB", msg:"disconnect failed: " + (e?.message || e)});
    }
  });

  mbSendTestBtn?.addEventListener("click", async () => {
    try{
      await microbit.sendLine("TEST");
      logEvent({dir:"TX", src:"MB", msg:"TEST"});
    } catch(e){
      logEvent({dir:"SYS", src:"MB", msg:"TEST failed: " + (e?.message || e)});
    }
  });

  mbBridgeOnBtn?.addEventListener("click", () => {
    mbBridgeEnabled = true;
    startSafetyWatchdog();
    logEvent({dir:"SYS", src:"MB", msg:"bridge enabled (peer → micro:bit)"});
  });
  mbBridgeOffBtn?.addEventListener("click", () => {
    mbBridgeEnabled = false;
    logEvent({dir:"SYS", src:"MB", msg:"bridge disabled"});
  });
})();
setStatus("Idle");
setConnStatus("Not connected", false);
