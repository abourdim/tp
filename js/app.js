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

function setStatus(t){ if(statusPill) statusPill.textContent = t; }
function log(...args){
  const line = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  console.log(line);
  if (logEl) logEl.textContent += line + "\n";
}

let localStream = null;
let peer = null;
let call = null;

let isHost = false;
let hostId = null;

// Camera switching / mirroring
let videoDevices = [];
let currentDeviceIndex = 0;
let currentFacing = "user"; // user | environment
let isMirrored = true;

function setMirror(on){
  isMirrored = !!on;
  if (!localVideo) return;
  localVideo.classList.toggle("mirrored", isMirrored);
  if (flipBtn) flipBtn.textContent = isMirrored ? "Unmirror 🪞" : "Mirror self 🪞";

let isRemoteMirrored = false;
function setRemoteMirror(on){
  isRemoteMirrored = !!on;
  if (!remoteVideo) return;
  remoteVideo.classList.toggle("mirrored", isRemoteMirrored);
  if (flipRemoteBtn) flipRemoteBtn.textContent = isRemoteMirrored ? "Unflip remote ↔️" : "Flip remote ↔️";
}

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
  flipRemoteBtn && (flipRemoteBtn.disabled = false);
  await refreshVideoDevices();
  setMirror(true);

  setStatus("Camera ON 🎥");
  log("Local stream tracks:", localStream.getTracks().map(t=>`${t.kind}:${t.readyState}`).join(", "));
  return localStream;
}

function cleanupPeer(){
  try { call?.close(); } catch {}
  call = null;
  try { peer?.destroy(); } catch {}
  peer = null;
  isHost = false;
  hostId = null;
  if (remoteVideo) remoteVideo.srcObject = null;
  hangupBtn.style.display = "none";
}

function attachCallHandlers(c){
  call = c;
  hangupBtn.style.display = "";
  c.on("stream", (remoteStream) => {
    log("Remote stream received:", remoteStream.getTracks().map(t=>`${t.kind}:${t.readyState}`).join(", "));
    remoteVideo.srcObject = remoteStream;
    remoteVideo.play().catch(()=>{});
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
  setRemoteMirror(!isRemoteMirrored);
  log("Remote flip:", isRemoteMirrored ? "ON" : "OFF");
});

// Nice default status
setStatus("Idle");
