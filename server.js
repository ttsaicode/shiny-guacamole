const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

// Railway provides PORT in production.
// Local development falls back to 3000.
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

const publicDir = path.join(__dirname, "public");


// ==================================================
// HTTP SERVER
// ==================================================

const server = http.createServer((req, res) => {
  let requestPath = req.url.split("?")[0];

  if (requestPath === "/") {
    requestPath = "/index.html";
  }

  try {
    requestPath = decodeURIComponent(requestPath);
  } catch (error) {
    console.error("Bad request URL:", error);

    res.writeHead(400);
    res.end("Bad request");

    return;
  }

  const filePath = path.resolve(
    publicDir,
    "." + requestPath
  );

  // Prevent requests outside the public folder.
  if (
    filePath !== publicDir &&
    !filePath.startsWith(publicDir + path.sep)
  ) {
    console.log("Blocked path:", requestPath);

    res.writeHead(403);
    res.end("Forbidden");

    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      console.log(
        "File not found:",
        filePath
      );

      res.writeHead(404);
      res.end("Not found");

      return;
    }

    const extension =
      path.extname(filePath).toLowerCase();

    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8"
    };

    const contentType =
      contentTypes[extension] ||
      "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": contentType
    });

    res.end(data);
  });
});


// ==================================================
// WEBSOCKET SERVER
// ==================================================

const wss = new WebSocket.Server({
  server
});


// Each connected browser gets an ID.
let nextClientId = 1;

// Browsers waiting for a match.
const waitingClients = [];


// ==================================================
// HELPER: SEND MESSAGE
// ==================================================

function send(socket, message) {
  if (
    socket &&
    socket.readyState === WebSocket.OPEN
  ) {
    socket.send(JSON.stringify(message));
  }
}


// ==================================================
// HELPER: REMOVE FROM WAITING QUEUE
// ==================================================

function removeFromWaiting(socket) {
  const index =
    waitingClients.indexOf(socket);

  if (index !== -1) {
    waitingClients.splice(index, 1);
  }
}


// ==================================================
// HELPER: PUT USER BACK IN WAITING QUEUE
// ==================================================

function putInWaitingQueue(socket) {
  if (
    !socket ||
    socket.readyState !== WebSocket.OPEN
  ) {
    return;
  }

  if (socket.peer) {
    return;
  }

  if (!waitingClients.includes(socket)) {
    waitingClients.push(socket);

    console.log(
      `[SERVER] Client ${socket.id} is waiting.`
    );
  }

  send(socket, {
    type: "waiting"
  });
}


// ==================================================
// MATCH TWO USERS
// ==================================================

function tryMatchUsers() {
  // Remove closed connections from queue.
  for (
    let i = waitingClients.length - 1;
    i >= 0;
    i--
  ) {
    if (
      waitingClients[i].readyState !==
      WebSocket.OPEN
    ) {
      waitingClients.splice(i, 1);
    }
  }

  while (waitingClients.length >= 2) {
    const clientA =
      waitingClients.shift();

    const clientB =
      waitingClients.shift();

    if (
      clientA.readyState !== WebSocket.OPEN ||
      clientB.readyState !== WebSocket.OPEN
    ) {
      continue;
    }

    // Pair them.
    clientA.peer = clientB;
    clientB.peer = clientA;

    console.log("");
    console.log("========================================");
    console.log(
      `[MATCH] Client ${clientA.id} matched with Client ${clientB.id}`
    );
    console.log("========================================");
    console.log("");

    send(clientA, {
      type: "matched",
      role: "caller"
    });

    send(clientB, {
      type: "matched",
      role: "callee"
    });

    // Only the caller creates the offer.
    send(clientA, {
      type: "create-offer"
    });
  }
}


// ==================================================
// NEW WEBSOCKET CONNECTION
// ==================================================

wss.on("connection", (socket, request) => {
  socket.id = nextClientId++;
  socket.ready = false;
  socket.peer = null;

  console.log("");
  console.log(
    `[SERVER] Client ${socket.id} connected`
  );
  console.log(
    `[SERVER] IP: ${request.socket.remoteAddress}`
  );
  console.log("");

  // ------------------------------------------------
  // RECEIVE MESSAGE
  // ------------------------------------------------

  socket.on("message", (rawMessage) => {
    let message;

    try {
      message = JSON.parse(
        rawMessage.toString()
      );
    } catch (error) {
      console.error(
        `[SERVER] Client ${socket.id} sent invalid JSON`
      );

      return;
    }

    console.log(
      `[SERVER] Client ${socket.id} -> ${message.type}`
    );


    // ==============================================
    // USER READY
    // ==============================================

    if (message.type === "ready") {
      if (socket.ready) {
        console.log(
          `[SERVER] Client ${socket.id} already ready`
        );

        return;
      }

      socket.ready = true;

      console.log(
        `[SERVER] Client ${socket.id} is ready for matching`
      );

      putInWaitingQueue(socket);

      tryMatchUsers();

      return;
    }


    // ==============================================
    // SKIP / FIND NEW PERSON
    // ==============================================

    if (message.type === "skip") {
      console.log(
        `[SERVER] Client ${socket.id} requested skip`
      );

      const oldPeer = socket.peer;

      socket.peer = null;

      if (oldPeer) {
        oldPeer.peer = null;

        send(oldPeer, {
          type: "peer-disconnected"
        });

        if (oldPeer.ready) {
          putInWaitingQueue(oldPeer);
        }
      }

      putInWaitingQueue(socket);

      tryMatchUsers();

      return;
    }


    // ==============================================
    // FORWARD SIGNALING MESSAGE ONLY TO MATCHED PEER
    // ==============================================

    if (
      message.type === "offer" ||
      message.type === "answer" ||
      message.type === "ice-candidate"
    ) {
      if (
        socket.peer &&
        socket.peer.readyState ===
          WebSocket.OPEN
      ) {
        console.log(
          `[SIGNAL] ${socket.id} -> ${socket.peer.id}: ${message.type}`
        );

        send(
          socket.peer,
          message
        );
      } else {
        console.log(
          `[SERVER] Client ${socket.id} has no peer for ${message.type}`
        );
      }

      return;
    }

    console.log(
      `[SERVER] Unknown message type: ${message.type}`
    );
  });


  // ------------------------------------------------
  // SOCKET ERROR
  // ------------------------------------------------

  socket.on("error", (error) => {
    console.error(
      `[SERVER] WebSocket error for Client ${socket.id}:`,
      error.message
    );
  });


  // ------------------------------------------------
  // CLIENT DISCONNECTS
  // ------------------------------------------------

  socket.on("close", () => {
    console.log("");
    console.log(
      `[SERVER] Client ${socket.id} disconnected`
    );

    removeFromWaiting(socket);

    const oldPeer = socket.peer;

    socket.peer = null;

    if (oldPeer) {
      oldPeer.peer = null;

      console.log(
        `[SERVER] Client ${oldPeer.id} lost their peer`
      );

      send(oldPeer, {
        type: "peer-disconnected"
      });

      // Put remaining person back in queue.
      if (oldPeer.ready) {
        putInWaitingQueue(oldPeer);

        tryMatchUsers();
      }
    }
  });
});


// ==================================================
// START SERVER
// ==================================================

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("========================================");
  console.log(" WebRTC signaling server is running");
  console.log("========================================");
  console.log(`Host: ${HOST}`);
  console.log(`Port: ${PORT}`);

  if (process.env.PORT) {
    console.log("Environment: Railway / production");
  } else {
    console.log("Environment: Local development");
    console.log(
      `Open: http://localhost:${PORT}`
    );
  }

  console.log("========================================");
  console.log("");
});
