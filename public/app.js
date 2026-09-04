"use strict";

/*
  ============================================================
  HEY - WEBRTC CLIENT
  ============================================================

  This file handles:

  - Camera + microphone
  - WebSocket signaling
  - WebRTC peer connection
  - STUN / TURN
  - DataChannel chat
  - Next
  - Report
  - Stop / completely destroy current connection
  ============================================================
*/


/* ============================================================
   DOM ELEMENTS
   ============================================================ */

const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");

const localPlaceholder = document.getElementById("localPlaceholder");
const remotePlaceholder = document.getElementById("remotePlaceholder");

const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const nextButton = document.getElementById("nextButton");

const chatToggleButton = document.getElementById("chatToggleButton");
const reportButton = document.getElementById("reportButton");

const statusElement = document.getElementById("status");

const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatMessages = document.getElementById("chatMessages");
const sendChatButton = document.getElementById("sendChatButton");

const reportModalBackdrop =
  document.getElementById("reportModalBackdrop");

const cancelReportButton =
  document.getElementById("cancelReportButton");

const submitReportButton =
  document.getElementById("submitReportButton");


/* ============================================================
   WEBRTC CONFIGURATION
   ============================================================ */

const rtcConfiguration = {
  iceServers: [
    {
      urls:"stun:free.expressturn.com:3478"
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

  /*
    "all" allows the browser to use:

    - host candidates
    - STUN candidates
    - TURN relay candidates

    This is what we want for normal operation.
  */

  iceTransportPolicy: "all"
};


/* ============================================================
   STATE
   ============================================================ */

let localStream = null;

let peerConnection = null;

let socket = null;

let chatChannel = null;

let pendingIceCandidates = [];

let hasStartedCamera = false;

let isMatched = false;

let chatEnabled = true;


/* ============================================================
   DEBUGGING
   ============================================================ */

function debug(...args) {
  console.log("[HEY]", ...args);
}


/* ============================================================
   STATUS
   ============================================================ */

function setStatus(message) {
  statusElement.textContent = message;
  debug(message);
}


/* ============================================================
   VIDEO PLACEHOLDERS
   ============================================================ */

function updateVideoPlaceholders() {
  if (localStream) {
    localPlaceholder.style.display = "none";
  } else {
    localPlaceholder.style.display = "flex";
  }

  if (remoteVideo.srcObject) {
    remotePlaceholder.style.display = "none";
  } else {
    remotePlaceholder.style.display = "flex";
  }
}


/* ============================================================
   BUTTON STATE
   ============================================================ */

function updateMatchButtons() {
  nextButton.disabled = !isMatched;
  reportButton.disabled = !isMatched;

  chatToggleButton.disabled = !isMatched;

  if (isMatched) {
    chatToggleButton.textContent = chatEnabled
      ? "💬 Chat: ON"
      : "💬 Chat: OFF";
  }
}


function updateStopButton() {
  stopButton.disabled = !hasStartedCamera;
}


/* ============================================================
   WEBSOCKET CONNECTION
   ============================================================ */

function connectToSignalingServer() {
  if (
    socket &&
    (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    )
  ) {
    return;
  }

  const protocol =
    window.location.protocol === "https:"
      ? "wss:"
      : "ws:";

  const socketUrl =
    `${protocol}//${window.location.host}`;

  debug("Connecting to signaling server:", socketUrl);

  socket = new WebSocket(socketUrl);

  socket.addEventListener("open", () => {
    debug("Connected to signaling server");

    if (hasStartedCamera) {
      setStatus("Connected. Looking for someone...");
    }
  });

  socket.addEventListener("message", async (event) => {
    try {
      const message = JSON.parse(event.data);

      debug("Received signaling message:", message.type);

      await handleSignalingMessage(message);

    } catch (error) {
      console.error(
        "[HEY] Error handling server message:",
        error
      );
    }
  });

  socket.addEventListener("close", (event) => {
    debug(
      "Signaling server connection closed.",
      {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean
      }
    );

    socket = null;

    /*
      The browser can reconnect later when Start Camera
      is clicked again.
    */

    if (hasStartedCamera) {
      setStatus(
        "Signaling server disconnected. Please try again."
      );
    }
  });

  socket.addEventListener("error", (error) => {
    console.error(
      "[HEY] WebSocket error:",
      error
    );
  });
}


/* ============================================================
   SEND WEBSOCKET MESSAGE
   ============================================================ */

function sendMessage(message) {
  if (
    socket &&
    socket.readyState === WebSocket.OPEN
  ) {
    debug("Sending:", message.type);

    socket.send(JSON.stringify(message));

    return true;
  }

  debug(
    "Could not send message. WebSocket not open:",
    message.type
  );

  return false;
}


/* ============================================================
   START CAMERA
   ============================================================ */

async function startCamera() {
  if (hasStartedCamera) {
    return;
  }

  try {
    setStatus("Requesting camera and microphone...");

    /*
      Ask the browser for camera + microphone.
    */

    const stream =
      await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });

    localStream = stream;

    localVideo.srcObject = localStream;

    hasStartedCamera = true;

    startButton.disabled = true;

    updateStopButton();
    updateVideoPlaceholders();

    debug("Camera and microphone obtained.");

    /*
      Make sure signaling is connected.
    */

    connectToSignalingServer();

    /*
      If the socket is already connected, tell the
      server that this browser is ready to match.
    */

    if (
      socket &&
      socket.readyState === WebSocket.OPEN
    ) {
      createPeerConnection();

      sendMessage({
        type: "ready"
      });

      setStatus("Looking for someone...");
    } else {
      setStatus("Connecting to server...");

      /*
        The socket open handler doesn't automatically create
        the peer connection if the connection wasn't ready yet.
      */

      const waitForSocket = setInterval(() => {
        if (!hasStartedCamera) {
          clearInterval(waitForSocket);
          return;
        }

        if (
          socket &&
          socket.readyState === WebSocket.OPEN
        ) {
          clearInterval(waitForSocket);

          createPeerConnection();

          sendMessage({
            type: "ready"
          });

          setStatus("Looking for someone...");
        }
      }, 100);
    }

  } catch (error) {
    console.error(
      "[HEY] Camera/microphone error:",
      error
    );

    hasStartedCamera = false;

    startButton.disabled = false;

    updateStopButton();

    setStatus(
      "Could not access your camera or microphone."
    );

    alert(
      "Please allow camera and microphone access in your browser."
    );
  }
}


/* ============================================================
   CREATE PEER CONNECTION
   ============================================================ */

function createPeerConnection() {
  /*
    If an old peer connection exists, close it first.
  */

  if (peerConnection) {
    try {
      peerConnection.close();
    } catch (error) {
      console.warn(
        "[HEY] Error closing old peer connection:",
        error
      );
    }
  }

  pendingIceCandidates = [];

  debug("Creating RTCPeerConnection...");

  peerConnection =
    new RTCPeerConnection(rtcConfiguration);


  /* ----------------------------------------------------------
     ADD LOCAL TRACKS
     ---------------------------------------------------------- */

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      peerConnection.addTrack(
        track,
        localStream
      );
    });
  }


  /* ----------------------------------------------------------
     REMOTE TRACK
     ---------------------------------------------------------- */

  peerConnection.addEventListener(
    "track",
    (event) => {
      debug("Remote track received.");

      if (
        event.streams &&
        event.streams[0]
      ) {
        remoteVideo.srcObject =
          event.streams[0];

        updateVideoPlaceholders();
      }
    }
  );


  /* ----------------------------------------------------------
     ICE CANDIDATES
     ---------------------------------------------------------- */

  peerConnection.addEventListener(
    "icecandidate",
    (event) => {
      if (event.candidate) {
        debug(
          "Sending ICE candidate:",
          getCandidateSummary(event.candidate)
        );

        sendMessage({
          type: "ice-candidate",
          candidate: event.candidate
        });
      } else {
        debug("ICE gathering completed.");
      }
    }
  );


  /* ----------------------------------------------------------
     ICE CONNECTION STATE
     ---------------------------------------------------------- */

  peerConnection.addEventListener(
    "iceconnectionstatechange",
    () => {
      if (!peerConnection) {
        return;
      }

      const state =
        peerConnection.iceConnectionState;

      debug("ICE state:", state);

      if (state === "checking") {
        setStatus("Connecting to stranger...");
      }

      if (state === "connected") {
        setStatus("Connected!");
      }

      if (state === "completed") {
        setStatus("Connected!");
      }

      if (state === "disconnected") {
        debug(
          "ICE temporarily disconnected."
        );
      }

      if (state === "failed") {
        setStatus(
          "Video connection failed."
        );

        debug(
          "WebRTC connection failed. TURN may have failed."
        );
      }

      if (state === "closed") {
        debug(
          "ICE connection closed."
        );
      }
    }
  );


  /* ----------------------------------------------------------
     PEER CONNECTION STATE
     ---------------------------------------------------------- */

  peerConnection.addEventListener(
    "connectionstatechange",
    () => {
      if (!peerConnection) {
        return;
      }

      const state =
        peerConnection.connectionState;

      debug(
        "WebRTC connection state:",
        state
      );

      if (state === "connected") {
        setStatus("Connected!");
      }

      if (state === "failed") {
        setStatus(
          "Video connection failed."
        );
      }

      if (state === "disconnected") {
        debug(
          "Peer connection disconnected."
        );
      }
    }
  );


  /* ----------------------------------------------------------
     SIGNALING STATE
     ---------------------------------------------------------- */

  peerConnection.addEventListener(
    "signalingstatechange",
    () => {
      if (!peerConnection) {
        return;
      }

      debug(
        "Signaling state:",
        peerConnection.signalingState
      );
    }
  );


  /* ----------------------------------------------------------
     NEGOTIATION NEEDED
     ---------------------------------------------------------- */

  peerConnection.addEventListener(
    "negotiationneeded",
    () => {
      debug("Negotiation needed.");
    }
  );


  /* ----------------------------------------------------------
     DATA CHANNEL
     ---------------------------------------------------------- */

  peerConnection.addEventListener(
    "datachannel",
    (event) => {
      debug("Received chat DataChannel.");

      setupChatChannel(event.channel);
    }
  );
}


/* ============================================================
   CREATE OFFER
   ============================================================ */

async function createOffer() {
  if (!peerConnection) {
    debug(
      "Cannot create offer. No peer connection."
    );

    return;
  }

  try {
    /*
      The caller creates the DataChannel.

      The other browser receives it through the
      "datachannel" event.
    */

    if (!chatChannel) {
      const channel =
        peerConnection.createDataChannel(
          "chat"
        );

      setupChatChannel(channel);
    }

    const offer =
      await peerConnection.createOffer();

    await peerConnection.setLocalDescription(
      offer
    );

    debug("Sending offer.");

    sendMessage({
      type: "offer",
      offer: peerConnection.localDescription
    });

  } catch (error) {
    console.error(
      "[HEY] Error creating offer:",
      error
    );
  }
}


/* ============================================================
   HANDLE OFFER
   ============================================================ */

async function handleOffer(offer) {
  if (!peerConnection) {
    createPeerConnection();
  }

  try {
    debug("Received WebRTC offer.");

    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(offer)
    );

    await processPendingIceCandidates();

    const answer =
      await peerConnection.createAnswer();

    await peerConnection.setLocalDescription(
      answer
    );

    debug("Sending answer.");

    sendMessage({
      type: "answer",
      answer: peerConnection.localDescription
    });

  } catch (error) {
    console.error(
      "[HEY] Error handling offer:",
      error
    );
  }
}


/* ============================================================
   HANDLE ANSWER
   ============================================================ */

async function handleAnswer(answer) {
  if (!peerConnection) {
    return;
  }

  try {
    debug("Received WebRTC answer.");

    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(answer)
    );

    await processPendingIceCandidates();

  } catch (error) {
    console.error(
      "[HEY] Error handling answer:",
      error
    );
  }
}


/* ============================================================
   HANDLE ICE CANDIDATE
   ============================================================ */

async function handleIceCandidate(candidate) {
  if (!peerConnection) {
    return;
  }

  /*
    ICE candidates can arrive before remote SDP.

    Save them until remoteDescription exists.
  */

  if (
    !peerConnection.remoteDescription ||
    !peerConnection.remoteDescription.type
  ) {
    debug(
      "Remote description not ready."
    );

    debug(
      "Saving ICE candidate for later."
    );

    pendingIceCandidates.push(candidate);

    return;
  }

  try {
    await peerConnection.addIceCandidate(
      new RTCIceCandidate(candidate)
    );

  } catch (error) {
    console.error(
      "[HEY] Error adding ICE candidate:",
      error
    );
  }
}


/* ============================================================
   PROCESS SAVED ICE CANDIDATES
   ============================================================ */

async function processPendingIceCandidates() {
  if (!peerConnection) {
    return;
  }

  if (
    !peerConnection.remoteDescription ||
    !peerConnection.remoteDescription.type
  ) {
    return;
  }

  if (pendingIceCandidates.length === 0) {
    return;
  }

  debug(
    "Processing",
    pendingIceCandidates.length,
    "saved ICE candidates."
  );

  const candidates =
    pendingIceCandidates;

  pendingIceCandidates = [];

  for (const candidate of candidates) {
    try {
      await peerConnection.addIceCandidate(
        new RTCIceCandidate(candidate)
      );
    } catch (error) {
      console.error(
        "[HEY] Error processing saved ICE candidate:",
        error
      );
    }
  }
}


/* ============================================================
   HANDLE SIGNALING MESSAGE
   ============================================================ */

async function handleSignalingMessage(message) {
  switch (message.type) {

    case "waiting":
      isMatched = false;

      updateMatchButtons();

      setStatus(
        "Waiting for a stranger..."
      );

      break;


    case "matched":
      isMatched = true;

      chatEnabled = true;

      clearChat();

      updateMatchButtons();

      setStatus(
        "Matched! Connecting..."
      );

      break;


    case "create-offer":
      debug(
        "Server asked us to create an offer."
      );

      await createOffer();

      break;


    case "offer":
      await handleOffer(
        message.offer
      );

      break;


    case "answer":
      await handleAnswer(
        message.answer
      );

      break;


    case "ice-candidate":
      await handleIceCandidate(
        message.candidate
      );

      break;


    case "peer-disconnected":
      handlePeerDisconnected();

      break;


    default:
      debug(
        "Unknown signaling message:",
        message.type
      );
  }
}


/* ============================================================
   PEER DISCONNECTED
   ============================================================ */

function handlePeerDisconnected() {
  debug(
    "Stranger disconnected."
  );

  isMatched = false;

  closeChatChannel();

  clearChat();

  if (peerConnection) {
    try {
      peerConnection.close();
    } catch (error) {
      console.warn(
        "[HEY] Error closing peer connection:",
        error
      );
    }
  }

  peerConnection = null;

  pendingIceCandidates = [];

  remoteVideo.srcObject = null;

  updateVideoPlaceholders();

  updateMatchButtons();

  if (hasStartedCamera) {
    /*
      Automatically create a fresh peer connection
      and tell the server we are ready for another
      stranger.
    */

    createPeerConnection();

    sendMessage({
      type: "ready"
    });

    setStatus(
      "Stranger left. Looking for someone new..."
    );
  }
}


/* ============================================================
   STOP VIDEO CHAT
   ============================================================ */

function stopVideoChat() {
  debug(
    "Stopping video chat and destroying connection."
  );

  /*
    Tell the server to disconnect us from the
    current stranger.

    The server will notify the stranger.
  */

  sendMessage({
    type: "stop"
  });


  /* ----------------------------------------------------------
     LOCAL STATE
     ---------------------------------------------------------- */

  isMatched = false;

  updateMatchButtons();


  /* ----------------------------------------------------------
     CHAT
     ---------------------------------------------------------- */

  closeChatChannel();

  clearChat();


  /* ----------------------------------------------------------
     STOP CAMERA + MICROPHONE
     ---------------------------------------------------------- */

  if (localStream) {
    localStream
      .getTracks()
      .forEach((track) => {
        try {
          track.stop();
        } catch (error) {
          console.warn(
            "[HEY] Could not stop media track:",
            error
          );
        }
      });
  }

  localStream = null;


  /* ----------------------------------------------------------
     CLOSE WEBRTC
     ---------------------------------------------------------- */

  if (peerConnection) {
    try {
      peerConnection.close();
    } catch (error) {
      console.warn(
        "[HEY] Error closing peer connection:",
        error
      );
    }
  }

  peerConnection = null;

  pendingIceCandidates = [];


  /* ----------------------------------------------------------
     CLEAR VIDEO
     ---------------------------------------------------------- */

  remoteVideo.srcObject = null;

  localVideo.srcObject = null;


  /* ----------------------------------------------------------
     RESET STATE
     ---------------------------------------------------------- */

  hasStartedCamera = false;

  startButton.disabled = false;

  updateStopButton();

  updateVideoPlaceholders();

  setStatus(
    "Stopped. Click Start Camera when you want to begin again."
  );
}


/* ============================================================
   NEXT
   ============================================================ */

function nextStranger() {
  if (!hasStartedCamera) {
    return;
  }

  debug(
    "Looking for next stranger."
  );

  sendMessage({
    type: "skip"
  });

  isMatched = false;

  closeChatChannel();

  clearChat();

  if (peerConnection) {
    try {
      peerConnection.close();
    } catch (error) {
      console.warn(
        "[HEY] Error closing peer connection:",
        error
      );
    }
  }

  peerConnection = null;

  pendingIceCandidates = [];

  remoteVideo.srcObject = null;

  updateVideoPlaceholders();

  updateMatchButtons();

  setStatus(
    "Looking for someone new..."
  );
}


/* ============================================================
   CHAT DATA CHANNEL
   ============================================================ */

function setupChatChannel(channel) {
  chatChannel = channel;

  chatChannel.addEventListener(
    "open",
    () => {
      debug(
        "Chat DataChannel opened."
      );

      chatEnabled = true;

      updateMatchButtons();
    }
  );

  chatChannel.addEventListener(
    "close",
    () => {
      debug(
        "Chat DataChannel closed."
      );

      chatChannel = null;
    }
  );

  chatChannel.addEventListener(
    "error",
    (error) => {
      console.error(
        "[HEY] Chat DataChannel error:",
        error
      );
    }
  );

  chatChannel.addEventListener(
    "message",
    (event) => {
      try {
        const message =
          JSON.parse(event.data);

        if (
          message.type === "chat" &&
          typeof message.text === "string"
        ) {
          addChatMessage(
            message.text,
            false
          );
        }

      } catch (error) {
        console.error(
          "[HEY] Could not read chat message:",
          error
        );
      }
    }
  );
}


/* ============================================================
   CLOSE CHAT CHANNEL
   ============================================================ */

function closeChatChannel() {
  if (!chatChannel) {
    return;
  }

  try {
    chatChannel.close();
  } catch (error) {
    console.warn(
      "[HEY] Error closing chat channel:",
      error
    );
  }

  chatChannel = null;
}


/* ============================================================
   SEND CHAT MESSAGE
   ============================================================ */

function sendChatMessage() {
  if (!chatEnabled) {
    return;
  }

  if (!chatChannel) {
    return;
  }

  if (
    chatChannel.readyState !== "open"
  ) {
    return;
  }

  const text =
    chatInput.value.trim();

  if (!text) {
    return;
  }

  const message = {
    type: "chat",
    text: text
  };

  try {
    chatChannel.send(
      JSON.stringify(message)
    );

    addChatMessage(
      text,
      true
    );

    chatInput.value = "";

  } catch (error) {
    console.error(
      "[HEY] Failed to send chat message:",
      error
    );
  }
}


/* ============================================================
   ADD CHAT MESSAGE TO UI
   ============================================================ */

function addChatMessage(
  text,
  mine
) {
  const messageElement =
    document.createElement("div");

  messageElement.className =
    `chat-message ${mine ? "mine" : "theirs"}`;

  /*
    textContent is intentional.

    It prevents users from injecting HTML
    through chat messages.
  */

  messageElement.textContent = text;

  chatMessages.appendChild(
    messageElement
  );

  chatMessages.scrollTop =
    chatMessages.scrollHeight;
}


/* ============================================================
   CLEAR CHAT
   ============================================================ */

function clearChat() {
  chatMessages.innerHTML = "";
}


/* ============================================================
   CHAT TOGGLE
   ============================================================ */

function toggleChat() {
  chatEnabled = !chatEnabled;

  chatToggleButton.textContent =
    chatEnabled
      ? "💬 Chat: ON"
      : "💬 Chat: OFF";

  /*
    This only disables sending.

    The DataChannel itself stays alive.
  */

  chatInput.disabled =
    !chatEnabled;

  sendChatButton.disabled =
    !chatEnabled;
}


/* ============================================================
   REPORT MODAL
   ============================================================ */

function openReportModal() {
  if (!isMatched) {
    return;
  }

  reportModalBackdrop.classList.add(
    "show"
  );
}


function closeReportModal() {
  reportModalBackdrop.classList.remove(
    "show"
  );
}


function getSelectedReportReason() {
  const selected =
    document.querySelector(
      'input[name="reportReason"]:checked'
    );

  return selected
    ? selected.value
    : null;
}


function submitReport() {
  if (!isMatched) {
    closeReportModal();
    return;
  }

  const reason =
    getSelectedReportReason();

  if (!reason) {
    alert(
      "Please select a reason for the report."
    );

    return;
  }

  debug(
    "Submitting report:",
    reason
  );

  /*
    The server currently needs to be expanded to
    store/process reports. For now we send the
    report event to the signaling server.
  */

  sendMessage({
    type: "report",
    reason: reason
  });

  closeReportModal();

  alert(
    "Thank you. Your report has been submitted."
  );
}


/* ============================================================
   ICE DEBUG HELPER
   ============================================================ */

function getCandidateSummary(candidate) {
  if (!candidate) {
    return null;
  }

  const text =
    candidate.candidate || "";

  const typeMatch =
    text.match(/ typ ([a-zA-Z0-9]+)/);

  const protocolMatch =
    text.match(
      /candidate:\S+ \d+ (\w+)/i
    );

  return {
    type:
      typeMatch
        ? typeMatch[1]
        : "unknown",

    protocol:
      protocolMatch
        ? protocolMatch[1]
        : "unknown"
  };
}


/* ============================================================
   BUTTON EVENTS
   ============================================================ */

startButton.addEventListener(
  "click",
  startCamera
);


stopButton.addEventListener(
  "click",
  stopVideoChat
);


nextButton.addEventListener(
  "click",
  nextStranger
);


chatToggleButton.addEventListener(
  "click",
  toggleChat
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


chatForm.addEventListener(
  "submit",
  (event) => {
    event.preventDefault();

    sendChatMessage();
  }
);


/* ============================================================
   CLOSE REPORT MODAL WHEN CLICKING BACKDROP
   ============================================================ */

reportModalBackdrop.addEventListener(
  "click",
  (event) => {
    if (
      event.target ===
      reportModalBackdrop
    ) {
      closeReportModal();
    }
  }
);


/* ============================================================
   INITIAL UI STATE
   ============================================================ */

updateMatchButtons();

updateStopButton();

updateVideoPlaceholders();

setStatus(
  "Click Start Camera to begin"
);
