// Telepresence: audio/video call + data channel (commands/text) over PeerJS.
// No explicit "role": first peer that successfully claims ROOM-host becomes the host,
// others become guests and connect to the host.

let peer = null;
let mediaCall = null;
let dataConn = null;

let localStream = null;
let dataReady = false;

const el = (id) => document.getElementById(id);
const logEl = el("log");
const statusEl = el("status");

function setStatus(msg) {
  statusEl.textContent = msg;
}

function log(msg) {
  logEl.textContent += msg + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function enableControls(on) {
  document.querySelectorAll(".ctl").forEach((b) => {
    b.disabled = !on;
    b.style.opacity = on ? "1" : "0.4";
  });
}

enableControls(false);
setStatus("Not connected");

async function startCamera() {
  if (localStream) return;
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  el("local").srcObject = localStream;
  log("Camera started");
}

el("start").addEventListener("click", async () => {
  try {
    await startCamera();
  } catch (e) {
    console.error(e);
    log("Camera error: " + (e?.message || e));
  }
});

function newMsgId() {
  // crypto.randomUUID is not available on some older browsers.
  return (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function sendData(payload) {
  if (!dataConn || !dataConn.open || !dataReady) {
    log("❌ Not ready (data channel not open yet).");
    return;
  }
  const msg = { ...payload, _id: newMsgId(), _ts: Date.now() };
  dataConn.send(msg);
  log("SEND " + JSON.stringify(msg));
  // Basic timeout warning for ACK
  const id = msg._id;
  setTimeout(() => {
    // If still connected, remind user if no ACK logged (best-effort; no state kept).
    if (dataConn && dataConn.open) {
      // no-op; ACK will appear in log if received
    }
  }, 1500);
}

function attachDataHandlers(conn) {
  dataConn = conn;

  conn.on("open", () => {
    dataReady = true;
    setStatus("Data channel open ✅");
    log("Data channel open ✅");
    enableControls(true);
  });

  conn.on("data", (msg) => {
    log("RECV " + JSON.stringify(msg));

    // ACK handling
    if (msg && msg.type === "ack" && msg._id) {
      log("ACK ✅ " + msg._id);
      return;
    }
    if (msg && msg._id) {
      // reply ACK
      if (dataConn && dataConn.open) {
        dataConn.send({ type: "ack", _id: msg._id });
      }
    }
  });

  conn.on("close", () => {
    dataReady = false;
    enableControls(false);
    setStatus("Data channel closed");
    log("Data channel closed");
  });

  conn.on("error", (err) => {
    console.error(err);
    log("Data channel error: " + (err?.message || err));
  });
}

function attachCallHandlers(call) {
  mediaCall = call;
  call.on("stream", (remoteStream) => {
    el("remote").srcObject = remoteStream;
    log("Remote stream attached");
  });
  call.on("close", () => log("Media call closed"));
  call.on("error", (err) => {
    console.error(err);
    log("Media call error: " + (err?.message || err));
  });
}

async function connectRoom() {
  const room = el("room").value.trim() || "demo";
  await startCamera();

  // Try to become host first.
  const hostId = `${room}-host`;
  const guestId = `${room}-guest-${Math.random().toString(36).slice(2, 8)}`;

  setStatus("Connecting…");
  log("Connecting… room=" + room);

  function startAsHost() {
    peer = new Peer(hostId);
    peer.on("open", () => {
      setStatus("Host ready ✅");
      log("Peer open as HOST: " + hostId);
      // Host waits for incoming connections/calls.
    });

    peer.on("call", (incomingCall) => {
      log("Incoming media call");
      incomingCall.answer(localStream);
      attachCallHandlers(incomingCall);
    });

    peer.on("connection", (conn) => {
      log("Incoming data connection");
      attachDataHandlers(conn);
    });

    peer.on("error", (err) => {
      // If host id is taken, become guest.
      if (err && (err.type === "unavailable-id" || (err.message || "").includes("unavailable"))) {
        log("Host ID taken → switching to GUEST");
        try { peer.destroy(); } catch {}
        startAsGuest();
        return;
      }
      console.error(err);
      log("Peer error: " + (err?.type || "") + " " + (err?.message || err));
    });
  }

  function startAsGuest() {
    peer = new Peer(guestId);

    peer.on("open", () => {
      setStatus("Guest connecting…");
      log("Peer open as GUEST: " + guestId);

      // Connect data first
      const conn = peer.connect(hostId, { reliable: true });
      attachDataHandlers(conn);

      // Start media call
      const call = peer.call(hostId, localStream);
      attachCallHandlers(call);

      setStatus("Calling host…");
      log("Calling host: " + hostId);
    });

    peer.on("call", (incomingCall) => {
      // In case host calls back (shouldn't), answer.
      log("Incoming media call (unexpected, answering)");
      incomingCall.answer(localStream);
      attachCallHandlers(incomingCall);
    });

    peer.on("connection", (conn) => {
      // In case host initiates data (shouldn't), accept.
      log("Incoming data connection (unexpected)");
      attachDataHandlers(conn);
    });

    peer.on("error", (err) => {
      console.error(err);
      log("Peer error: " + (err?.type || "") + " " + (err?.message || err));
      setStatus("Peer error");
    });
  }

  startAsHost();
}

el("connect").addEventListener("click", () => {
  connectRoom().catch((e) => {
    console.error(e);
    log("Connect error: " + (e?.message || e));
    setStatus("Connect error");
  });
});

// Virtual controls: press & hold for direction, click for buttons.
document.querySelectorAll("[data-cmd]").forEach((btn) => {
  const cmd = btn.dataset.cmd;

  const press = (pressed) => {
    sendData({ type: "cmd", cmd, pressed });
  };

  btn.addEventListener("mousedown", () => press(true));
  btn.addEventListener("mouseup", () => press(false));
  btn.addEventListener("mouseleave", () => press(false));

  btn.addEventListener("touchstart", (e) => {
    e.preventDefault();
    press(true);
  }, { passive: false });

  btn.addEventListener("touchend", (e) => {
    e.preventDefault();
    press(false);
  }, { passive: false });
});

document.querySelectorAll("[data-btn]").forEach((btn) => {
  const id = btn.dataset.btn;

  const press = (pressed) => {
    sendData({ type: "btn", id, pressed });
  };

  btn.addEventListener("mousedown", () => press(true));
  btn.addEventListener("mouseup", () => press(false));
  btn.addEventListener("mouseleave", () => press(false));

  btn.addEventListener("touchstart", (e) => {
    e.preventDefault();
    press(true);
  }, { passive: false });

  btn.addEventListener("touchend", (e) => {
    e.preventDefault();
    press(false);
  }, { passive: false });
});

el("send").addEventListener("click", () => {
  const text = el("text").value || "";
  sendData({ type: "text", text });
});
