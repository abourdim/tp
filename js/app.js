let peer, conn, call;
let localStream;
let dataReady = false;

const logEl = document.getElementById("log");
const statusEl = document.getElementById("status");
const log = m => { logEl.textContent += m + "\n"; };
const status = m => statusEl.textContent = m;

const myId = Math.random().toString(36).slice(2);

document.getElementById("startCam").onclick = async () => {
  localStream = await navigator.mediaDevices.getUserMedia({video:true,audio:true});
  document.getElementById("localVideo").srcObject = localStream;
  status("Camera started");
};

document.getElementById("connect").onclick = () => {
  const room = document.getElementById("room").value;
  const id = room + "-" + myId;

  peer = new Peer(id);
  status("My ID: " + id);

  peer.on("open", () => {
    peer.listAllPeers(list => {
      list.filter(p => p.startsWith(room + "-") && p !== id)
          .forEach(connectTo);
    });
  });

  peer.on("call", c => {
    call = c;
    call.answer(localStream);
    call.on("stream", s => remoteVideo.srcObject = s);
  });

  peer.on("connection", c => setupConn(c));
};

function connectTo(other) {
  log("Connecting to " + other);
  call = peer.call(other, localStream);
  call.on("stream", s => remoteVideo.srcObject = s);
  setupConn(peer.connect(other));
}

function setupConn(c) {
  conn = c;
  conn.on("open", () => {
    dataReady = true;
    status("Data channel open");
  });

  conn.on("data", d => {
    log("RECV " + JSON.stringify(d));
    if (d._id) conn.send({type:"ack", _id:d._id});
  });
}

function send(data) {
  if (!dataReady) {
    log("Data not ready");
    return;
  }
  data._id = crypto.randomUUID();
  conn.send(data);
  log("SEND " + JSON.stringify(data));
}

document.querySelectorAll("[data-cmd]").forEach(b => {
  b.onmousedown = () => send({type:"cmd", cmd:b.dataset.cmd});
});

document.getElementById("sendText").onclick = () =>
  send({type:"text", text:document.getElementById("textInput").value});
