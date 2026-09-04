// ==================================================
// DOM ELEMENTS
// ==================================================

const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const startButton = document.getElementById("startButton");
const statusText = document.getElementById("status");

const localPlaceholder = document.getElementById("localPlaceholder");
const remotePlaceholder = document.getElementById("remotePlaceholder");

const chat = document.getElementById("chat");
const chatMessages = document.getElementById("chatMessages");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatToggle = document.getElementById("chatToggle");

const reportButton = document.getElementById("reportButton");
const nextButton = document.getElementById("nextButton");

const reportModal = document.getElementById("reportModal");
const cancelReportButton = document.getElementById("cancelReport");
const submitReportButton = document.getElementById("submitReport");

// ==================================================
// VARIABLES
// ==================================================

let localStream = null;
let peerConnection = null;
let socket = null;

let pendingIceCandidates = [];
let hasStartedCamera = false;
let isMatched = false;

let chatChannel = null;
let chatEnabled = true;

// ==================================================
// WEBRTC CONFIGURATION
// ==================================================

const rtcConfiguration = {
  iceServers: [
    {
      urls: [
        "stun:free.expressturn.com:3478"
      ]
    },
    {
      urls: [
        "turn:free.expressturn.com:3478?transport=udp",
        "turn:free.expressturn.com:3478?transport=tcp"
      ],
        urls: 'turn:free.expressturn.com:3478',
        username: "000000002103732653",
        credential: "rgTyOIK/8pVvQzdnm7e5jave1MA="
    }
  ],

  // "all" lets WebRTC try direct/STUN paths first
  // and use TURN when a relay is needed.
  iceTransportPolicy: "all",

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
// UI HELPERS
// ==================================================

function updateVideoPlaceholders() {
  localPlaceholder.style.display = localVideo.srcObject ? "none" : "flex";
  remotePlaceholder.style.display = remoteVideo.srcObject ? "none" : "flex";
}

function updateMatchButtons() {
  reportButton.disabled = !isMatched;
  nextButton.disabled = !isMatched;
}

function clearChat() {
  chatMessages.innerHTML = "";
}

function addChatMessage(sender, text) {
  const messageElement = document.createElement("div");

  messageElement.className =
    `chat-message ${sender === "You" ? "you" : "stranger"}`;

  const senderElement = document.createElement("span");
  senderElement.className = "sender";
  senderElement.textContent = `${sender}:`;

  const textElement = document.createElement("span");
  textElement.textContent = text;

  messageElement.appendChild(senderElement);
  messageElement.appendChild(textElement);

  chatMessages.appendChild(messageElement);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function updateChatUI() {
  chat.style.display = chatEnabled ? "flex" : "none";
  chatToggle.textContent = chatEnabled
    ? "💬 Chat: ON"
    : "💬 Chat: OFF";
}

function setChatInputEnabled(enabled) {
  chatInput.disabled = !enabled;
}

function closeChatChannel() {
  if (chatChannel) {
    try {
      chatChannel.close();
    } catch (error) {
      debugError("Failed to close chat channel", error);
    }
  }

  chatChannel = null;
  setChatInputEnabled(false);
}

// ==================================================
// CHAT DATA CHANNEL
// ==================================================

function setupChatChannel(channel) {
  closeChatChannel();

  chatChannel = channel;

  chatChannel.addEventListener("open", () => {
    debug("Chat data channel opened.");
    setChatInputEnabled(true);
  });

  chatChannel.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === "chat" && typeof data.text === "string") {
        addChatMessage("Stranger", data.text);
      }
    } catch (error) {
      debugError("Could not process chat message", error);
    }
  });

  chatChannel.addEventListener("close", () => {
    debug("Chat data channel closed.");
    setChatInputEnabled(false);
  });

  chatChannel.addEventListener("error", (error) => {
    debugError("Chat data channel error", error);
  });

  if (chatChannel.readyState === "open") {
    setChatInputEnabled(true);
  }
}

// ==================================================
// SEND CHAT MESSAGE
// ==================================================

function sendChatMessage(text) {
  const cleanText = text.trim();

  if (!cleanText || !chatChannel) {
    return;
  }

  if (chatChannel.readyState !== "open") {
    setStatus("Chat is not ready yet.");
    return;
  }

  const message = {
    type: "chat",
    text: cleanText
  };

  try {
    chatChannel.send(JSON.stringify(message));
    addChatMessage("You", cleanText);
  } catch (error) {
    debugError("Failed to send chat message", error);
  }
}

// ==================================================
// SEND SIGNALING MESSAGE
// ==================================================

function sendMessage(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    debug(
      "Cannot send signaling message. Socket is not open.",
      message
    );
    return;
  }

  debug("Sending signaling message", message.type);
  socket.send(JSON.stringify(message));
}

// ==================================================
// CONNECT TO SIGNALING SERVER
// ==================================================

function connectSignaling() {
  const protocol =
    window.location.protocol === "https:" ? "wss:" : "ws:";

  const socketUrl =
    `${protocol}//${window.location.host}`;

  debug("Connecting to signaling server", socketUrl);

  socket = new WebSocket(socketUrl);

  socket.addEventListener("open", () => {
    debug("WebSocket connected successfully");
    setStatus("Connected. Click Start Camera.");
  });

  socket.addEventListener("message", async (event) => {
    try {
      const message = JSON.parse(event.data);

      debug(
        "Received signaling message",
        message.type
      );

      switch (message.type) {
        case "waiting":
          isMatched = false;
          updateMatchButtons();
          setStatus("Waiting for another person...");
          break;

        case "matched":
          isMatched = true;
          updateMatchButtons();

          clearChat();

          debug(
            "Matched with another browser",
            message
          );

          setStatus("Partner found. Connecting...");
          break;

        case "create-offer":
          debug(
            "Server asked us to create an offer."
          );

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
          debug(
            "Unknown signaling message",
            message
          );
      }

    } catch (error) {
      debugError(
        "Error processing signaling message",
        error
      );
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

    setStatus(
      "Signaling server disconnected."
    );
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
    debug(
      "Requesting camera and microphone..."
    );

    localStream =
      await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });

    debug(
      "Camera and microphone obtained."
    );

    localVideo.srcObject = localStream;

    hasStartedCamera = true;

    startButton.disabled = true;

    updateVideoPlaceholders();

    await createPeerConnection();

    setStatus(
      "Ready. Finding another person..."
    );

    sendMessage({
      type: "ready"
    });

  } catch (error) {
    debugError(
      "Camera/microphone error",
      error
    );

    setStatus(
      `Could not access camera/microphone: ${error.name} - ${error.message}`
    );
  }
}

// ==================================================
// CREATE PEER CONNECTION
// ==================================================

async function createPeerConnection() {
  if (peerConnection) {
    debug("Closing old PeerConnection");

    try {
      peerConnection.close();
    } catch (error) {
      debugError(
        "Failed to close old PeerConnection",
        error
      );
    }
  }

  closeChatChannel();

  pendingIceCandidates = [];

  debug(
    "Creating RTCPeerConnection",
    rtcConfiguration
  );

  peerConnection =
    new RTCPeerConnection(
      rtcConfiguration
    );

  if (!localStream) {
    throw new Error(
      "No local camera/microphone stream exists."
    );
  }

  localStream
    .getTracks()
    .forEach((track) => {
      debug(
        "Adding local track",
        track.kind
      );

      peerConnection.addTrack(
        track,
        localStream
      );
    });

  // The callee receives the channel created by the caller.
  peerConnection.addEventListener(
    "datachannel",
    (event) => {
      debug(
        "Remote data channel received",
        event.channel.label
      );

      if (event.channel.label === "chat") {
        setupChatChannel(event.channel);
      }
    }
  );

  peerConnection.addEventListener(
    "track",
    (event) => {
      debug(
        "REMOTE TRACK RECEIVED",
        {
          kind: event.track.kind,
          streams: event.streams.length
        }
      );

      if (
        event.streams &&
        event.streams[0]
      ) {
        remoteVideo.srcObject =
          event.streams[0];

        updateVideoPlaceholders();

        debug(
          "Remote stream attached to video"
        );
      }
    }
  );

  peerConnection.addEventListener(
    "icecandidate",
    (event) => {
      if (!event.candidate) {
        debug(
          "ICE gathering finished."
        );

        return;
      }

      debug(
        "Sending ICE candidate.",
        {
          type: event.candidate.type,
          protocol: event.candidate.protocol
        }
      );

      sendMessage({
        type: "ice-candidate",
        candidate: event.candidate
      });
    }
  );

  peerConnection.addEventListener(
    "icegatheringstatechange",
    () => {
      debug(
        "ICE gathering state:",
        peerConnection.iceGatheringState
      );
    }
  );

  peerConnection.addEventListener(
    "iceconnectionstatechange",
    () => {
      const state =
        peerConnection.iceConnectionState;

      debug(
        "ICE state:",
        state
      );

      if (state === "checking") {
        setStatus(
          "Connecting video..."
        );
      }

      if (
        state === "connected" ||
        state === "completed"
      ) {
        setStatus(
          "Video connected!"
        );

        logSelectedCandidatePair();
      }

      if (state === "disconnected") {
        setStatus(
          "Connection unstable, reconnecting..."
        );

        debug(
          "ICE temporarily disconnected."
        );
      }

      if (state === "failed") {
        setStatus(
          "Video connection failed."
        );

        debugError(
          "ICE connection failed."
        );

        try {
          peerConnection.restartIce();
        } catch (error) {
          debugError(
            "ICE restart failed",
            error
          );
        }
      }

      if (state === "closed") {
        debug(
          "ICE connection closed."
        );
      }
    }
  );

  peerConnection.addEventListener(
    "connectionstatechange",
    () => {
      const state =
        peerConnection.connectionState;

      debug(
        "WebRTC connection state:",
        state
      );

      if (state === "connected") {
        setStatus(
          "Video connected!"
        );

        setChatInputEnabled(
          chatChannel &&
          chatChannel.readyState === "open"
        );

        logSelectedCandidatePair();
      }

      if (state === "failed") {
        setStatus(
          "Video connection failed."
        );
      }
    }
  );

  peerConnection.addEventListener(
    "signalingstatechange",
    () => {
      debug(
        "Signaling state:",
        peerConnection.signalingState
      );
    }
  );

  peerConnection.addEventListener(
    "negotiationneeded",
    () => {
      debug(
        "Negotiation needed."
      );
    }
  );
}

// ==================================================
// CREATE OFFER
// ==================================================

async function createOffer() {
  if (!peerConnection) {
    debugError(
      "Cannot create offer. No PeerConnection."
    );

    return;
  }

  try {
    debug(
      "Creating WebRTC offer..."
    );

    // Only the caller creates the chat data channel.
    if (
      !chatChannel ||
      chatChannel.readyState === "closed"
    ) {
      const channel =
        peerConnection.createDataChannel(
          "chat"
        );

      setupChatChannel(channel);
    }

    const offer =
      await peerConnection.createOffer();

    debug(
      "Setting local description..."
    );

    await peerConnection.setLocalDescription(
      offer
    );

    debug(
      "Sending offer..."
    );

    sendMessage({
      type: "offer",
      offer:
        peerConnection.localDescription
    });

  } catch (error) {
    debugError(
      "Failed to create offer",
      error
    );
  }
}

// ==================================================
// HANDLE OFFER
// ==================================================

async function handleOffer(message) {
  if (!peerConnection) {
    debugError(
      "Received offer but PeerConnection does not exist."
    );

    return;
  }

  try {
    debug(
      "Received WebRTC offer."
    );

    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(
        message.offer
      )
    );

    debug(
      "Remote description set."
    );

    await processPendingIceCandidates();

    const answer =
      await peerConnection.createAnswer();

    await peerConnection.setLocalDescription(
      answer
    );

    debug(
      "Sending answer..."
    );

    sendMessage({
      type: "answer",
      answer:
        peerConnection.localDescription
    });

  } catch (error) {
    debugError(
      "Failed to handle offer",
      error
    );
  }
}

// ==================================================
// HANDLE ANSWER
// ==================================================

async function handleAnswer(message) {
  if (!peerConnection) {
    debugError(
      "Received answer but PeerConnection does not exist."
    );

    return;
  }

  try {
    debug(
      "Received WebRTC answer."
    );

    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(
        message.answer
      )
    );

    debug(
      "Remote answer description set."
    );

    await processPendingIceCandidates();

  } catch (error) {
    debugError(
      "Failed to handle answer",
      error
    );
  }
}

// ==================================================
// HANDLE ICE CANDIDATE
// ==================================================

async function handleIceCandidate(message) {
  if (!message.candidate) {
    return;
  }

  const candidateText =
    message.candidate.candidate || "";

  debug(
    "Received remote ICE candidate.",
    candidateText
  );

  if (
    !peerConnection ||
    !peerConnection.remoteDescription
  ) {
    debug(
      "Remote description not ready."
    );

    pendingIceCandidates.push(
      message.candidate
    );

    debug(
      "Saving ICE candidate for later."
    );

    return;
  }

  try {
    await peerConnection.addIceCandidate(
      new RTCIceCandidate(
        message.candidate
      )
    );

    debug(
      "ICE candidate added."
    );

  } catch (error) {
    debugError(
      "Failed to add ICE candidate",
      error
    );
  }
}

// ==================================================
// PROCESS SAVED ICE CANDIDATES
// ==================================================

async function processPendingIceCandidates() {
  if (
    !peerConnection ||
    !peerConnection.remoteDescription ||
    pendingIceCandidates.length === 0
  ) {
    return;
  }

  debug(
    `Processing ${pendingIceCandidates.length} saved ICE candidates.`
  );

  const candidates =
    [...pendingIceCandidates];

  pendingIceCandidates = [];

  for (
    const candidate of candidates
  ) {
    try {
      await peerConnection.addIceCandidate(
        new RTCIceCandidate(
          candidate
        )
      );

      debug(
        "Saved ICE candidate added."
      );

    } catch (error) {
      debugError(
        "Failed to add saved ICE candidate",
        error
      );
    }
  }
}

// ==================================================
// PEER DISCONNECTED
// ==================================================

function handlePeerDisconnected() {
  debug(
    "Peer disconnected."
  );

  isMatched = false;

  updateMatchButtons();

  pendingIceCandidates = [];

  closeChatChannel();

  if (peerConnection) {
    try {
      peerConnection.close();
    } catch (error) {
      debugError(
        "Failed to close peer connection",
        error
      );
    }

    peerConnection = null;
  }

  remoteVideo.srcObject = null;

  updateVideoPlaceholders();

  clearChat();

  if (localStream) {
    createPeerConnection()
      .then(() => {
        setStatus(
          "Partner disconnected. Finding someone new..."
        );

        sendMessage({
          type: "ready"
        });
      })
      .catch((error) => {
        debugError(
          "Failed to recreate PeerConnection",
          error
        );
      });
  }
}

// ==================================================
// NEXT / SKIP
// ==================================================

async function nextPartner() {
  if (!hasStartedCamera) {
    return;
  }

  debug("Looking for next partner.");

  isMatched = false;
  updateMatchButtons();

  closeChatChannel();

  clearChat();

  remoteVideo.srcObject = null;

  updateVideoPlaceholders();

  sendMessage({
    type: "skip"
  });

  try {
    await createPeerConnection();

    setStatus(
      "Finding someone new..."
    );

    sendMessage({
      type: "ready"
    });

  } catch (error) {
    debugError(
      "Failed to prepare next connection",
      error
    );
  }
}

// ==================================================
// REPORT MODAL
// ==================================================

function openReportModal() {
  if (!isMatched) {
    return;
  }

  reportModal.classList.add("open");
  reportModal.setAttribute(
    "aria-hidden",
    "false"
  );

  submitReportButton.disabled = true;

  document
    .querySelectorAll(
      'input[name="reportReason"]'
    )
    .forEach((input) => {
      input.checked = false;
    });
}

function closeReportModal() {
  reportModal.classList.remove("open");
  reportModal.setAttribute(
    "aria-hidden",
    "true"
  );
}

function submitReport() {
  const selected =
    document.querySelector(
      'input[name="reportReason"]:checked'
    );

  if (!selected) {
    return;
  }

  const reason = selected.value;

  debug(
    "Report submitted",
    reason
  );

  // Send the report through the signaling connection.
  // The server can later store this in a database/moderation system.
  sendMessage({
    type: "report",
    reason
  });

  closeReportModal();

  setStatus(
    "Report submitted. Thank you."
  );
}

// ==================================================
// GET SELECTED ICE CANDIDATE PAIR
// ==================================================

async function logSelectedCandidatePair() {
  if (!peerConnection) {
    return;
  }

  try {
    const stats =
      await peerConnection.getStats();

    let selectedPair = null;

    stats.forEach((report) => {
      if (
        report.type === "candidate-pair" &&
        (
          report.selected === true ||
          report.nominated === true
        )
      ) {
        selectedPair = report;
      }
    });

    if (!selectedPair) {
      debug(
        "No selected ICE candidate pair found yet."
      );

      return;
    }

    const localCandidate =
      stats.get(
        selectedPair.localCandidateId
      );

    const remoteCandidate =
      stats.get(
        selectedPair.remoteCandidateId
      );

    debug(
      "SELECTED ICE CANDIDATE PAIR",
      {
        localType:
          localCandidate?.candidateType,

        remoteType:
          remoteCandidate?.candidateType,

        localProtocol:
          localCandidate?.protocol,

        remoteProtocol:
          remoteCandidate?.protocol,

        state:
          selectedPair.state
      }
    );

  } catch (error) {
    debugError(
      "Could not inspect selected ICE candidate pair",
      error
    );
  }
}

// ==================================================
// UI EVENTS
// ==================================================

startButton.addEventListener(
  "click",
  startCamera
);

chatForm.addEventListener(
  "submit",
  (event) => {
    event.preventDefault();

    const text =
      chatInput.value.trim();

    if (!text) {
      return;
    }

    sendChatMessage(text);

    chatInput.value = "";
    chatInput.focus();
  }
);

chatToggle.addEventListener(
  "click",
  () => {
    chatEnabled = !chatEnabled;
    updateChatUI();
  }
);

nextButton.addEventListener(
  "click",
  nextPartner
);

reportButton.addEventListener(
  "click",
  openReportModal
);

cancelReportButton.addEventListener(
  "click",
  closeReportModal
);

submitReportButton.addEventListener(
  "click",
  submitReport
);

document
  .querySelectorAll(
    'input[name="reportReason"]'
  )
  .forEach((input) => {
    input.addEventListener(
      "change",
      () => {
        submitReportButton.disabled = false;
      }
    );
  });

reportModal.addEventListener(
  "click",
  (event) => {
    if (event.target === reportModal) {
      closeReportModal();
    }
  }
);

// ==================================================
// INITIALIZATION
// ==================================================

updateVideoPlaceholders();
updateMatchButtons();
updateChatUI();

connectSignaling();
