// ==================================================
// DOM ELEMENTS
// ==================================================

const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const startButton = document.getElementById("startButton");
const statusText = document.getElementById("status");

// ==================================================
// VARIABLES
// ==================================================

let localStream = null;
let peerConnection = null;
let socket = null;

let pendingIceCandidates = [];
let hasStartedCamera = false;
let isMatched = false;

// ==================================================
// WEBRTC CONFIGURATION
// ==================================================

const rtcConfiguration = {
  iceServers: [
    // STUN (helps discover public IP)
    { 
      urls: 'stun:free.expressturn.com:3478' 
    },
    // TURN (fallback for different networks)
    {
      urls: 'turn:free.expressturn.com:3478',
      username: "000000002103732653",
      credential: "rgTyOIK/8pVvQzdnm7e5jave1MA="
    }
  ],
  iceCandidatePoolSize: 10
};

// ==================================================
// DEBUG LOGGING
// ==================================================

function debug(title, data = "") {
  const time = new Date().toLocaleTimeString();
  console.log(
    `%c[${time}] ${title}`,
    "font-weight: bold; color: #00ff88;",
    data
  );
}

function debugError(title, error) {
  console.error(`[ERROR] ${title}`, error);
}

// ==================================================
// STATUS
// ==================================================

function setStatus(message) {
  console.log("[STATUS]", message);
  statusText.textContent = message;
}

// ==================================================
// SEND SIGNALING MESSAGE
// ==================================================

function sendMessage(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    debug("Cannot send signaling message. Socket is not open.", message);
    return;
  }
  debug("Sending signaling message", message.type);
  socket.send(JSON.stringify(message));
}

// ==================================================
// CONNECT TO SIGNALING SERVER
// ==================================================

function connectSignaling() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socketUrl = `${protocol}//${window.location.host}`;

  debug("Connecting to signaling server", socketUrl);
  socket = new WebSocket(socketUrl);

  socket.addEventListener("open", () => {
    debug("WebSocket connected successfully");
    setStatus("Connected. Click Start Camera.");
  });

  socket.addEventListener("message", async (event) => {
    try {
      const message = JSON.parse(event.data);
      debug("Received signaling message", message.type);

      switch (message.type) {
        case "waiting":
          setStatus("Waiting for another person...");
          break;

        case "matched":
          isMatched = true;
          debug("Matched with another browser", message);
          setStatus("Partner found. Connecting...");
          break;

        case "create-offer":
          debug("Server asked us to create an offer.");
          await createOffer();
          break;

        case "offer":
          await handleOffer(message);
          break;

        case "answer":
          await handleAnswer(message);
          break;

        case "ice-candidate":
          await handleIceCandidate(message);
          break;

        case "peer-disconnected":
          handlePeerDisconnected();
          break;

        default:
          debug("Unknown signaling message", message);
      }
    } catch (error) {
      debugError("Error processing signaling message", error);
    }
  });

  socket.addEventListener("error", (error) => {
    debugError("WebSocket error", error);
    setStatus("Signaling connection error.");
  });

  socket.addEventListener("close", (event) => {
    debug("WebSocket CLOSED", {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean
    });
    setStatus("Signaling server disconnected.");
  });
}

// ==================================================
// START CAMERA
// ==================================================

async function startCamera() {
  if (hasStartedCamera) {
    debug("Camera already started.");
    return;
  }

  try {
    debug("Requesting camera and microphone...");
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });

    debug("Camera and microphone obtained.");
    localVideo.srcObject = localStream;
    hasStartedCamera = true;
    startButton.disabled = true;

    await createPeerConnection();
    setStatus("Ready. Finding another person...");
    sendMessage({ type: "ready" });

  } catch (error) {
    debugError("Camera/microphone error", error);
    setStatus(`Could not access camera/microphone: ${error.name} - ${error.message}`);
  }
}

// ==================================================
// CREATE PEER CONNECTION
// ==================================================

async function createPeerConnection() {
  if (peerConnection) {
    debug("Closing old PeerConnection");
    peerConnection.close();
  }

  pendingIceCandidates = [];
  debug("Creating RTCPeerConnection", rtcConfiguration);
  peerConnection = new RTCPeerConnection(rtcConfiguration);

  if (!localStream) {
    throw new Error("No local camera/microphone stream exists.");
  }

  localStream.getTracks().forEach((track) => {
    debug("Adding local track", track.kind);
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.addEventListener("track", (event) => {
    debug("REMOTE TRACK RECEIVED", {
      kind: event.track.kind,
      streams: event.streams.length
    });

    if (event.streams && event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      debug("Remote stream attached to video");
    }
  });

  peerConnection.addEventListener("icecandidate", (event) => {
    if (!event.candidate) {
      debug("ICE gathering finished.");
      return;
    }
    debug("Sending ICE candidate.", {
      type: event.candidate.type,
      protocol: event.candidate.protocol
    });
    sendMessage({
      type: "ice-candidate",
      candidate: event.candidate
    });
  });

  peerConnection.addEventListener("icegatheringstatechange", () => {
    debug("ICE gathering state:", peerConnection.iceGatheringState);
  });

  peerConnection.addEventListener("iceconnectionstatechange", () => {
    const state = peerConnection.iceConnectionState;
    debug("ICE state:", state);

    if (state === "checking") {
      setStatus("Connecting video...");
    }
    if (state === "connected" || state === "completed") {
      setStatus("Video connected!");
      logSelectedCandidatePair();
    }
    if (state === "disconnected") {
      setStatus("Connection unstable, reconnecting...");
      debug("ICE temporarily disconnected.");
    }
    if (state === "failed") {
      setStatus("Video connection failed.");
      debugError("ICE connection failed.");
      try {
        peerConnection.restartIce();
      } catch (error) {
        debugError("ICE restart failed", error);
      }
    }
    if (state === "closed") {
      debug("ICE connection closed.");
    }
  });

  peerConnection.addEventListener("connectionstatechange", () => {
    const state = peerConnection.connectionState;
    debug("WebRTC connection state:", state);

    if (state === "connected") {
      setStatus("Video connected!");
      logSelectedCandidatePair();
    }
    if (state === "failed") {
      setStatus("Video connection failed.");
    }
  });

  peerConnection.addEventListener("signalingstatechange", () => {
    debug("Signaling state:", peerConnection.signalingState);
  });

  peerConnection.addEventListener("negotiationneeded", () => {
    debug("Negotiation needed.");
  });
}

// ==================================================
// CREATE OFFER
// ==================================================

async function createOffer() {
  if (!peerConnection) {
    debugError("Cannot create offer. No PeerConnection.");
    return;
  }
  try {
    debug("Creating WebRTC offer...");
    const offer = await peerConnection.createOffer();
    debug("Setting local description...");
    await peerConnection.setLocalDescription(offer);
    debug("Sending offer...");
    sendMessage({
      type: "offer",
      offer: peerConnection.localDescription
    });
  } catch (error) {
    debugError("Failed to create offer", error);
  }
}

// ==================================================
// HANDLE OFFER
// ==================================================

async function handleOffer(message) {
  if (!peerConnection) {
    debugError("Received offer but PeerConnection does not exist.");
    return;
  }
  try {
    debug("Received WebRTC offer.");
    await peerConnection.setRemoteDescription(new RTCSessionDescription(message.offer));
    debug("Remote description set.");
    await processPendingIceCandidates();
    
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    debug("Sending answer...");
    sendMessage({
      type: "answer",
      answer: peerConnection.localDescription
    });
  } catch (error) {
    debugError("Failed to handle offer", error);
  }
}

// ==================================================
// HANDLE ANSWER
// ==================================================

async function handleAnswer(message) {
  if (!peerConnection) {
    debugError("Received answer but PeerConnection does not exist.");
    return;
  }
  try {
    debug("Received WebRTC answer.");
    await peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));
    debug("Remote answer description set.");
    await processPendingIceCandidates();
  } catch (error) {
    debugError("Failed to handle answer", error);
  }
}

// ==================================================
// HANDLE ICE CANDIDATE
// ==================================================

async function handleIceCandidate(message) {
  if (!message.candidate) return;
  
  const candidateText = message.candidate.candidate || "";
  debug("Received remote ICE candidate.", candidateText);

  if (!peerConnection || !peerConnection.remoteDescription) {
    debug("Remote description not ready.");
    pendingIceCandidates.push(message.candidate);
    debug("Saving ICE candidate for later.");
    return;
  }

  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
    debug("ICE candidate added.");
  } catch (error) {
    debugError("Failed to add ICE candidate", error);
  }
}

// ==================================================
// PROCESS SAVED ICE CANDIDATES
// ==================================================

async function processPendingIceCandidates() {
  if (!peerConnection || !peerConnection.remoteDescription || pendingIceCandidates.length === 0) {
    return;
  }

  debug(`Processing ${pendingIceCandidates.length} saved ICE candidates.`);
  const candidates = [...pendingIceCandidates];
  pendingIceCandidates = [];

  for (const candidate of candidates) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      debug("Saved ICE candidate added.");
    } catch (error) {
      debugError("Failed to add saved ICE candidate", error);
    }
  }
}

// ==================================================
// PEER DISCONNECTED
// ==================================================

function handlePeerDisconnected() {
  debug("Peer disconnected.");
  isMatched = false;
  pendingIceCandidates = [];

  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  remoteVideo.srcObject = null;

  if (localStream) {
    createPeerConnection()
      .then(() => {
        setStatus("Partner disconnected. Finding someone new...");
        sendMessage({ type: "ready" });
      })
      .catch((error) => {
        debugError("Failed to recreate PeerConnection", error);
      });
  }
}

// ==================================================
// GET SELECTED ICE CANDIDATE PAIR
// ==================================================

async function logSelectedCandidatePair() {
  if (!peerConnection) return;

  try {
    const stats = await peerConnection.getStats();
    let selectedPair = null;

    stats.forEach((report) => {
      if (report.type === "candidate-pair" && (report.selected === true || report.nominated === true)) {
        selectedPair = report;
      }
    });

    if (!selectedPair) {
      debug("No selected ICE candidate pair found yet.");
      return;
    }

    const localCandidate = stats.get(selectedPair.localCandidateId);
    const remoteCandidate = stats.get(selectedPair.remoteCandidateId);

    debug("SELECTED ICE CANDIDATE PAIR", {
      localType: localCandidate?.candidateType,
      remoteType: remoteCandidate?.candidateType,
      localProtocol: localCandidate?.protocol,
      remoteProtocol: remoteCandidate?.protocol,
      state: selectedPair.state
    });

  } catch (error) {
    debugError("Could not inspect selected ICE candidate pair", error);
  }
}

// ==================================================
// INITIALIZATION
// ==================================================

startButton.addEventListener("click", startCamera);
connectSignaling();
