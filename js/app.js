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
const logEl = $("log");

const rxLog = $("rxLog");
const textInput = $("textInput");
const sendTextBtn = $("sendTextBtn");

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


function setStatus(t){ if(statusPill) statusPill.textContent = t; }
function log(...args){
  const line = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  console.log(line);
  if (logEl) logEl.textContent += line + "\n";
}

function logRx(...args){
  const line = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  console.log("[RX]", line);
  if (rxLog) rxLog.textContent += line + "\n";
}

function setDataConn(conn){
  if (!conn) return;
  try { dataConn?.close(); } catch {}
  dataConn = conn;

  conn.on("open", () => {
    log("Data channel open ✅");
    enableControls(true);
  });
  conn.on("data", (msg) => {
    // ACK handler
    if (msg && typeof msg === "object" && msg.type === "ack"){
      const id = msg._id || msg.id;
      if (id && _pending.has(id)){
        _pending.delete(id);
        logRx("ACK:", id);
      } else {
        logRx("ACK (unknown):", id || msg);
      }
      return;
    }

    // Normal messages: display + reply ACK
    if (msg && typeof msg === "object"){
      const id = msg._id || msg.id;

      if (msg.type === "text") logRx("TEXT:", msg.text);
      else if (msg.type === "cmd") logRx("CMD:", msg.cmd, msg.pressed ? "down" : "up");
      else if (msg.type === "btn") logRx("BTN:", msg.id, msg.pressed ? "down" : "up");
      else logRx(msg);

      // Send ACK back for anything with an id
      if (id && dataConn && dataConn.open){
        try { dataConn.send({ type: "ack", _id: id, _ts: Date.now() }); } catch {}
      }
    } else {
      logRx(msg);
    }
  });
  conn.on("close", () => {
    log("Data channel closed");
    enableControls(false);
  });
  conn.on("error", (e) => {
    log("Data channel error:", e?.message || String(e));
  });
}


// ---- DataChannel messaging + ACK ----
let _seq = 1;
const _pending = new Map(); // id -> {t, msg}

function sendMsg(obj){
  const id = obj && (obj._id || obj.id) ? (obj._id || obj.id) : String(_seq++);
  const msg = (obj && typeof obj === "object") ? { ...obj, _id: id, _ts: Date.now() } : obj;

  if (!dataConn || !dataConn.open){
    log("Send skipped (data channel not open):", JSON.stringify(msg));
    return false;
  }
  try{
    dataConn.send(msg);
    _pending.set(id, { t: Date.now(), msg });
    // Optional: show outgoing quickly
    // log("Sent:", JSON.stringify(msg));
    return id;
  }catch(e){
    log("Send failed:", e?.message || String(e));
    return false;
  }
}

// Mark timed-out pending messages (diagnostic)
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
}

function attachCallHandlers(c){
  call = c;
  hangupBtn.style.display = "";

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
    if (remoteFsBtn) remoteFsBtn.disabled = false;
  });

  // Once we know who we're connected to, try to ensure a data channel exists.
  // (The peer id is available immediately; no need to wait for stream.)
  ensureDataTo(c.peer);
  c.on("close", () => {
    log("Call closed");
    setStatus("Disconnected");
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
  const mid = sendMsg({ type: "text", text: t });
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
    const down = (e) => { e.preventDefault(); sendMsg({ type: "cmd", cmd, pressed: true }); };
    const up = (e) => { e.preventDefault(); sendMsg({ type: "cmd", cmd, pressed: false }); };
    btn.addEventListener("pointerdown", down);
    btn.addEventListener("pointerup", up);
    btn.addEventListener("pointercancel", up);
    btn.addEventListener("pointerleave", up);
  });

  // Buttons: click sends a tap (down then up)
  document.querySelectorAll("[data-btn]").forEach((btn) => {
    const id = btn.getAttribute("data-btn");
    btn.addEventListener("pointerdown", (e) => { e.preventDefault(); sendMsg({ type: "btn", id, pressed: true }); });
    btn.addEventListener("pointerup", (e) => { e.preventDefault(); sendMsg({ type: "btn", id, pressed: false }); });
    btn.addEventListener("pointercancel", (e) => { e.preventDefault(); sendMsg({ type: "btn", id, pressed: false }); });
    btn.addEventListener("pointerleave", (e) => { e.preventDefault(); sendMsg({ type: "btn", id, pressed: false }); });
  });
}

bindVirtualControls();

// Nice default status
setStatus("Idle");

