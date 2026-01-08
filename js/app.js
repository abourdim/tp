// Kid Telepresence (simple, single-page, no roles)
// How it works:
// - Both devices open the same page and enter the same room code
// - One device becomes "host" automatically (first to claim <room>-host ID)
// - The other becomes "guest" and calls the host
// - Both send+receive audio/video in a single PeerJS call

const $ = (id) => document.getElementById(id);

const roomInput = $("roomInput");
const startBtn = $("startBtn");
const switchCamBtn = $("switchCamBtn");
const flipBtn = $("flipBtn");
const flipRemoteBtn = $("flipRemoteBtn");
const connectBtn = $("connectBtn");
const hangupBtn = $("hangupBtn");
const localVideo = $("localVideo");
const remoteVideo = $("remoteVideo");
const statusPill = $("status");
const logEl = $("log");

// Gamepad UI
const gpStatus = $("gpStatus");
const gpSendState = $("gpSendState");
const gpLocalEl = $("gpLocal");
const gpRemoteEl = $("gpRemote");

function setStatus(t){ if(statusPill) statusPill.textContent = t; }
function log(...args){
  const line = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  console.log(line);
  if (logEl) logEl.textContent += line + "\n";
}

let localStream = null;
let peer = null;
let call = null;
let dataConn = null; // PeerJS DataConnection (WebRTC data channel)

let isHost = false;
let hostId = null;

// Camera switching / mirroring
let videoDevices = [];
let currentDeviceIndex = 0;
let currentFacing = "user"; // user | environment
let isMirrored = true;
let isRemoteFlipped = false;

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
  switchCamBtn && (switchCamBtn.disabled = false);
  flipBtn && (flipBtn.disabled = false);
  // Remote flip is a UI-only transform; enable once app is interactive
  flipRemoteBtn && (flipRemoteBtn.disabled = false);
  await refreshVideoDevices();
  setMirror(true);

  // Default: do not flip remote
  setRemoteFlip(false);

  setStatus("Camera ON 🎥");
  log("Local stream tracks:", localStream.getTracks().map(t=>`${t.kind}:${t.readyState}`).join(", "));
  return localStream;
}

function cleanupPeer(){
  try { call?.close(); } catch {}
  call = null;
  try { dataConn?.close(); } catch {}
  dataConn = null;
  try { peer?.destroy(); } catch {}
  peer = null;
  isHost = false;
  hostId = null;
  if (remoteVideo) remoteVideo.srcObject = null;
  // Keep flip state (UI preference) but ensure class is applied consistently
  setRemoteFlip(isRemoteFlipped);
  hangupBtn.style.display = "none";
}

function setGpStatus(text){
  if (gpStatus) gpStatus.textContent = text;
}

function setupDataConn(conn){
  if (!conn) return;
  // Keep a single active connection
  try { dataConn?.close(); } catch {}
  dataConn = conn;

  conn.on("open", () => {
    log("Data channel open ↔️");
    setStatus(call ? "Connected ✅" : "Data ready ✅");
  });

  conn.on("data", (payload) => {
    try{
      const msg = (typeof payload === "string") ? JSON.parse(payload) : payload;
      if (msg && msg.t === "gp"){
        if (gpRemoteEl) gpRemoteEl.textContent = formatGpState(msg);
      }
    }catch(e){
      // Ignore malformed payloads
    }
  });

  conn.on("close", () => {
    if (dataConn === conn) dataConn = null;
    log("Data channel closed");
  });

  conn.on("error", (e) => {
    log("Data channel error:", e?.message || String(e));
  });
}

function sendData(obj){
  if (!dataConn || !dataConn.open) return false;
  try{
    dataConn.send(JSON.stringify(obj));
    return true;
  }catch{
    return false;
  }
}

function formatGpState(msg){
  const axes = (msg.axes || []).map(v => Number(v).toFixed(2));
  const pressed = (msg.buttonsPressed || []).map(b => b ? 1 : 0);
  return [
    `ts: ${msg.ts || ""}`,
    `axes: [${axes.join(", ")}]`,
    `buttons: [${pressed.join("")}]`,
  ].join("\n");
}

function attachCallHandlers(c){
  call = c;
  hangupBtn.style.display = "";
  c.on("stream", (remoteStream) => {
    log("Remote stream received:", remoteStream.getTracks().map(t=>`${t.kind}:${t.readyState}`).join(", "));
    remoteVideo.srcObject = remoteStream;
    remoteVideo.play().catch(()=>{});
    // Re-apply remote flip preference after the element starts rendering
    setRemoteFlip(isRemoteFlipped);
    setStatus("Connected ✅");
  });
  c.on("close", () => {
    log("Call closed");
    setStatus("Disconnected");
    if (remoteVideo) remoteVideo.srcObject = null;
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

      // Open a data channel to the host for gamepad/control messages
      const conn = peer.connect(hostId, { reliable: true });
      setupDataConn(conn);
    });

    peer.on("connection", (conn) => {
      log("Incoming data channel (guest) from:", conn.peer);
      setupDataConn(conn);
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

  peer.on("connection", (conn) => {
    log("Incoming data channel (host) from:", conn.peer);
    setupDataConn(conn);
  });

  peer.on("call", (incoming) => {
    log("Incoming call (host) from:", incoming.peer);
    incoming.answer(localStream);
    attachCallHandlers(incoming);
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

// ---------- Gamepad -> send over data channel ----------

let gpActiveIndex = null;
let gpLast = { axes: [], buttonsPressed: [] };
let gpLastSentAt = 0;

function deadzone(v, dz=0.12){
  const x = Number(v) || 0;
  return (Math.abs(x) < dz) ? 0 : x;
}

function snapshotGamepad(gp){
  const axes = (gp?.axes || []).map(v => deadzone(v));
  const buttonsPressed = (gp?.buttons || []).map(b => !!b.pressed);
  return { axes, buttonsPressed };
}

function sameState(a, b){
  if (!a || !b) return false;
  if ((a.axes?.length || 0) !== (b.axes?.length || 0)) return false;
  if ((a.buttonsPressed?.length || 0) !== (b.buttonsPressed?.length || 0)) return false;
  for (let i=0;i<(a.axes?.length||0);i++){
    if (Math.abs((a.axes[i]||0)-(b.axes[i]||0)) > 0.02) return false;
  }
  for (let i=0;i<(a.buttonsPressed?.length||0);i++){
    if (!!a.buttonsPressed[i] !== !!b.buttonsPressed[i]) return false;
  }
  return true;
}

function updateGpUI(localState, sentOk){
  if (gpSendState) gpSendState.textContent = sentOk ? "sending" : (dataConn?.open ? "ready" : "not connected");
  if (gpLocalEl) gpLocalEl.textContent = localState ? formatGpState({ ...localState, ts: Date.now() }) : "(idle)";
}

function gpLoop(now){
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = (gpActiveIndex != null) ? pads[gpActiveIndex] : (pads && [...pads].find(p => p && p.connected));

  if (!gp){
    gpActiveIndex = null;
    setGpStatus("No gamepad");
    updateGpUI(null, false);
    requestAnimationFrame(gpLoop);
    return;
  }

  gpActiveIndex = gp.index;
  setGpStatus(`Gamepad: ${gp.id || "connected"}`);

  const snap = snapshotGamepad(gp);

  // Update UI every frame
  const canSend = !!(dataConn && dataConn.open);
  updateGpUI(snap, canSend);

  // Throttle sends to ~30Hz and only on change
  if (canSend && (now - gpLastSentAt) > 33 && !sameState(snap, gpLast)){
    gpLastSentAt = now;
    gpLast = snap;
    sendData({ t: "gp", ts: Date.now(), axes: snap.axes, buttonsPressed: snap.buttonsPressed });
  }

  requestAnimationFrame(gpLoop);
}

window.addEventListener("gamepadconnected", (e) => {
  log("Gamepad connected:", e.gamepad?.id || "(unknown)");
  setGpStatus(`Gamepad: ${e.gamepad?.id || "connected"}`);
});

window.addEventListener("gamepaddisconnected", (e) => {
  log("Gamepad disconnected:", e.gamepad?.id || "(unknown)");
  setGpStatus("No gamepad");
  gpActiveIndex = null;
});

// Start polling immediately (safe even without a gamepad)
requestAnimationFrame(gpLoop);

// Nice default status
setStatus("Idle");
