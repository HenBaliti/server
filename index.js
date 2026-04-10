const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

/**
 * ====== CONFIG ======
 */
const WAITING_TIMEOUT_MS = 60_000; // אחרי דקה נעדכן "still waiting" (לא נזרוק)
const RECONNECT_GRACE_MS = 20_000; // חלון זמן לחיבור מחדש
const QUEUE_TICK_MS = 1_000;

/**
 * ====== STATE (POC: in-memory) ======
 */
const waitingQueue = []; // [{ socketId, enqueuedAt, userProfile, filterPreferences }]
const partnerOf = new Map(); // socketId -> partnerSocketId
const socketProfiles = new Map(); // socketId -> userProfile

// reconnect
const socketIdByClientId = new Map(); // clientId -> socketId
const clientIdBySocketId = new Map(); // socketId -> clientId
const disconnectedAtByClientId = new Map(); // clientId -> timestamp

function now() {
  return Date.now();
}

function getQueuePosition(socketId) {
  const idx = waitingQueue.findIndex((x) => x.socketId === socketId);
  return idx === -1 ? null : idx + 1;
}

function safeRemoveFromQueue(socketId) {
  const idx = waitingQueue.findIndex((x) => x.socketId === socketId);
  if (idx !== -1) waitingQueue.splice(idx, 1);
}

function pair(a, b) {
  partnerOf.set(a, b);
  partnerOf.set(b, a);

  // Get profiles for both users
  const profileA = socketProfiles.get(a) || { gender: 'male', country: 'Unknown', subscriptionType: 'free', showLocation: true, showGender: true };
  const profileB = socketProfiles.get(b) || { gender: 'female', country: 'Unknown', subscriptionType: 'free', showLocation: true, showGender: true };

  io.to(a).emit("matched", { role: "caller", partnerInfo: profileB });
  io.to(b).emit("matched", { role: "callee", partnerInfo: profileA });
}

function unpair(id) {
  const p = partnerOf.get(id);
  if (p) {
    partnerOf.delete(id);
    partnerOf.delete(p);
  }
  return p;
}

function matchOrEnqueue(socket, userProfile, filterPreferences) {
  // אם כבר בזוג - לא לעשות כלום
  if (partnerOf.has(socket.id)) return;

  // Store user profile
  socketProfiles.set(socket.id, userProfile);

  // אם כבר בתור - רק לעדכן סטטוס
  if (waitingQueue.some((x) => x.socketId === socket.id)) {
    socket.emit("waiting");
    return;
  }

  // נקה את עצמך מכל מצב קודם
  safeRemoveFromQueue(socket.id);

  // נסה למצוא מישהו אחר בתור (ראש התור)
  const other = waitingQueue.shift();
  if (other && other.socketId !== socket.id) {
    pair(socket.id, other.socketId);
  } else {
    // אין מישהו מתאים - הכנס לתור
    waitingQueue.push({ socketId: socket.id, enqueuedAt: now(), userProfile, filterPreferences });
    socket.emit("waiting");
  }
}

// שליחת הודעת צ'אט לצד השני (רק אם יש partner)
function relayChat(fromSocketId, message) {
  const partner = partnerOf.get(fromSocketId);
  if (!partner) return;
  io.to(partner).emit("chat-message", message);
}

// Loop שמעדכן position/ETA + timeouts
setInterval(() => {
  const t = now();

  // ניקוי סוקטים "מתים" מהתור (אם הסוקט כבר לא קיים)
  for (let i = waitingQueue.length - 1; i >= 0; i--) {
    const sid = waitingQueue[i].socketId;
    if (!io.sockets.sockets.get(sid)) {
      waitingQueue.splice(i, 1);
    }
  }

  // עדכון סטטוס תור לכל מי שממתין
  waitingQueue.forEach((item, index) => {
    const sock = io.sockets.sockets.get(item.socketId);
    if (!sock) return;

    const waitedMs = t - item.enqueuedAt;
    const etaSec = Math.max(3, Math.round((index + 1) * 3)); // ETA פיקטיבי ל-POC

    sock.emit("queue-status", {
      position: index + 1,
      etaSec,
      waitedSec: Math.floor(waitedMs / 1000),
    });

    if (
      waitedMs > WAITING_TIMEOUT_MS &&
      waitedMs < WAITING_TIMEOUT_MS + QUEUE_TICK_MS
    ) {
      sock.emit("queue-timeout", {
        message: "עדיין מחפש מישהו להתחבר אליו…",
      });
    }
  });

  // נקה clientId ישנים (reconnect grace)
  for (const [clientId, ts] of disconnectedAtByClientId.entries()) {
    if (t - ts > RECONNECT_GRACE_MS) {
      disconnectedAtByClientId.delete(clientId);
      socketIdByClientId.delete(clientId);
    }
  }
}, QUEUE_TICK_MS);

io.on("connection", (socket) => {
  /**
   * HELLO: הלקוח שולח clientId מ-localStorage
   * זה מאפשר “reconnect” בסיסי בלי יוזרים.
   */
  socket.on("hello", ({ clientId }) => {
    if (!clientId) return;

    // אם clientId היה מחובר בעבר, ננתב אותו לסוקט החדש
    socketIdByClientId.set(clientId, socket.id);
    clientIdBySocketId.set(socket.id, clientId);

    // אם זה reconnect בתוך חלון grace - פשוט נאשר
    const discAt = disconnectedAtByClientId.get(clientId);
    if (discAt && now() - discAt <= RECONNECT_GRACE_MS) {
      socket.emit("reconnected", { ok: true });
      disconnectedAtByClientId.delete(clientId);
    } else {
      socket.emit("welcome", { ok: true });
    }
  });

  socket.on("find", ({ userProfile, filterPreferences }) => {
    matchOrEnqueue(socket, userProfile, filterPreferences);
  });

  socket.on("next", () => {
    // נתק זוג
    const partner = unpair(socket.id);
    if (partner) io.to(partner).emit("partner-left");

    // נקה תור + הכנס מחדש לפי רצון הלקוח
    safeRemoveFromQueue(socket.id);
    socket.emit("reset");
  });

  socket.on("stop", () => {
    const partner = unpair(socket.id);
    if (partner) io.to(partner).emit("partner-left");
    safeRemoveFromQueue(socket.id);
    socket.emit("reset");
  });

  // ===== WebRTC signaling relay =====
  socket.on("rtc-offer", (payload) => {
    const partner = partnerOf.get(socket.id);
    if (partner) io.to(partner).emit("rtc-offer", payload);
  });

  socket.on("rtc-answer", (payload) => {
    const partner = partnerOf.get(socket.id);
    if (partner) io.to(partner).emit("rtc-answer", payload);
  });

  socket.on("rtc-ice", (payload) => {
    const partner = partnerOf.get(socket.id);
    if (partner) io.to(partner).emit("rtc-ice", payload);
  });

  // ===== Text chat relay =====
  socket.on("chat-message", (payload) => {
    // payload: { id, text, ts }
    if (!payload?.text) return;
    relayChat(socket.id, payload);
  });

  socket.on("disconnect", () => {
    // אם היה בתור - להסיר
    safeRemoveFromQueue(socket.id);

    // Remove profile
    socketProfiles.delete(socket.id);

    // אם היה בזוג - להודיע לצד השני
    const partner = unpair(socket.id);
    if (partner) io.to(partner).emit("partner-left");

    // reconnect grace
    const clientId = clientIdBySocketId.get(socket.id);
    if (clientId) {
      disconnectedAtByClientId.set(clientId, now());
      clientIdBySocketId.delete(socket.id);
    }
  });
});

app.get("/health", (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Signaling server on :${PORT}`));
