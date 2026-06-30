// WebSocket server for WatchTogether extension
// Real-time sync relay between clients (playback sync + WebRTC signalling).

const WebSocket = require('ws');
const express = require('express');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// roomId -> {
//   participants: Map<userId, { ws, username, sessionId, lastHeartbeat }>,
//   recentSessions: Map<sessionId, lastSeenTs>,  // survives leave → reconnect grace
//   state: { time, paused, rate, lastUpdate }
// }
const rooms = new Map();

// `${roomId}:${sessionId}` -> timeout. A socket close defers the actual leave a few
// seconds so a quick same-tab reconnect (network blip) doesn't flap "left"/"joined".
const pendingLeaves = new Map();
const LEAVE_GRACE_MS = 6000;
const RECONNECT_GRACE_MS = 90000;

// ─── Module-scope helpers ───────────────────────────────────────────────────
// At module scope so the timers below can call them (closures can't be reached).

function generateUserId() {
  return Math.random().toString(36).substring(2, 15);
}

function participantList(room) {
  return Array.from(room.participants.entries()).map(([id, p]) => ({
    userId: id,
    username: p.username
  }));
}

function broadcastToRoom(roomId, message, excludeUserId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  const messageStr = JSON.stringify(message);
  room.participants.forEach((participant, id) => {
    if (id !== excludeUserId && participant.ws.readyState === WebSocket.OPEN) {
      try { participant.ws.send(messageStr); } catch {}
    }
  });
}

function broadcastParticipants(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  broadcastToRoom(roomId, {
    type: 'participants',
    count: room.participants.size,
    list: participantList(room)
  });
}

// Authoritative playback position, extrapolated from the last explicit action.
// room.state is ONLY written by explicit sync actions + join, never by heartbeats,
// so a passive/stale client can never drag the shared position backwards.
function currentRoomTime(room) {
  if (room.state.paused) return room.state.time;
  const elapsed = ((Date.now() - room.state.lastUpdate) / 1000) * (room.state.rate || 1);
  return room.state.time + elapsed;
}

// Idempotent: deletes the participant, notifies remaining peers, GCs empty rooms.
function leaveRoom(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const participant = room.participants.get(userId);
  if (!participant) return; // already removed — safe to call twice

  const username = participant.username;
  // Remember the session briefly so a reconnect just after removal is still
  // recognised as a reconnect (no spurious whole-room auto-pause).
  if (participant.sessionId) room.recentSessions.set(participant.sessionId, Date.now());
  room.participants.delete(userId);
  console.log(`${username} left room ${roomId}`);

  if (room.participants.size > 0) {
    broadcastToRoom(roomId, { type: 'left', username, userId });
    broadcastParticipants(roomId);
  } else {
    rooms.delete(roomId);
    console.log(`Room ${roomId} deleted (empty)`);
  }
}

function scheduleDeferredLeave(roomId, userId, sessionId) {
  if (!sessionId) { leaveRoom(roomId, userId); return; }
  const key = `${roomId}:${sessionId}`;
  if (pendingLeaves.has(key)) clearTimeout(pendingLeaves.get(key));
  const t = setTimeout(() => {
    pendingLeaves.delete(key);
    leaveRoom(roomId, userId);
  }, LEAVE_GRACE_MS);
  pendingLeaves.set(key, t);
}

function cancelDeferredLeave(roomId, sessionId) {
  if (!sessionId) return;
  const key = `${roomId}:${sessionId}`;
  if (pendingLeaves.has(key)) { clearTimeout(pendingLeaves.get(key)); pendingLeaves.delete(key); }
}

// ─── Per-connection handling ────────────────────────────────────────────────

wss.on('connection', (ws) => {
  const userId = generateUserId();
  let currentRoom = null;
  let currentUsername = null;
  let currentSessionId = null;

  // Liveness: server-initiated WS ping (handled by the browser's network stack,
  // so it is NOT throttled when the user's tab is backgrounded — unlike setInterval).
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      const p = room && room.participants.get(userId);
      if (p) {
        p.lastHeartbeat = Date.now();
        if (currentSessionId) room.recentSessions.set(currentSessionId, Date.now());
      }
    }
  });

  console.log(`New connection: ${userId}`);

  ws.on('message', (message) => {
    try {
      handleMessage(JSON.parse(message));
    } catch (error) {
      console.error('Error parsing message:', error.message);
    }
  });

  ws.on('close', () => {
    console.log(`Connection closed: ${userId}`);
    if (!currentRoom) return;
    // Defer so a fast same-tab reconnect doesn't produce a left/joined flap.
    // (An explicit 'leave' message takes the immediate path instead — see below.)
    scheduleDeferredLeave(currentRoom, userId, currentSessionId);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
  });

  function handleMessage(data) {
    switch (data.type) {
      case 'join':
        currentRoom = data.roomId;
        currentUsername = data.username;
        currentSessionId = data.sessionId || null;
        joinRoom(data.roomId, data.username, data.create, data.sessionId);
        break;
      case 'leave':
        // Intentional leave → remove now (no grace) so peers see "left" instantly.
        cancelDeferredLeave(data.roomId, currentSessionId);
        leaveRoom(data.roomId, userId);
        currentRoom = null;
        break;
      case 'sync': handleSync(data); break;
      case 'reaction': handleReaction(data); break;
      case 'request-sync': handleRequestSync(data); break;
      case 'chat': handleChat(data); break;
      case 'heartbeat': handleHeartbeat(data); break;
      case 'get_participants': handleGetParticipants(data); break;
      case 'webrtc-offer': relayWebRTC(data, 'webrtc-offer', { offer: data.offer }); break;
      case 'webrtc-answer': relayWebRTC(data, 'webrtc-answer', { answer: data.answer }); break;
      case 'webrtc-ice-candidate': relayWebRTC(data, 'webrtc-ice-candidate', { candidate: data.candidate }); break;
      case 'mic-status': handleMicStatus(data); break;
      case 'video-on':
      case 'video-off': handleVideoStatus(data); break;
    }
  }

  function joinRoom(roomId, username, create = false, sessionId = null) {
    if (!rooms.has(roomId)) {
      if (!create) {
        ws.send(JSON.stringify({
          type: 'error',
          code: 'ROOM_NOT_FOUND',
          message: 'Room not found. Check the room ID and try again.'
        }));
        return;
      }
      rooms.set(roomId, {
        participants: new Map(),
        recentSessions: new Map(),
        state: { time: 0, paused: true, rate: 1, lastUpdate: Date.now() }
      });
    }

    const room = rooms.get(roomId);
    if (!room.recentSessions) room.recentSessions = new Map();

    // This tab reconnected before its deferred-leave fired → cancel it.
    cancelDeferredLeave(roomId, sessionId);

    // Reconnect detection. A join is a reconnect if a live participant matches this
    // tab (sessionId) OR this sessionId was seen in the room very recently. The
    // recent-session check is essential: it stops a brief network drop (where the
    // old socket was already removed) from being misread as a brand-new joiner and
    // pausing the whole room.
    let isReconnect = false;
    const seenTs = sessionId ? room.recentSessions.get(sessionId) : null;
    if (seenTs && (Date.now() - seenTs) <= RECONNECT_GRACE_MS) isReconnect = true;

    // Evict any stale live socket for the same tab (or same username for legacy
    // clients with no sessionId). Tag the broadcast reason:'reconnect' so peers
    // clean up the ghost WITHOUT showing a misleading "left the room" message.
    const stale = [];
    for (const [existingId, p] of room.participants) {
      if (existingId === userId) continue;
      const sameTab = sessionId && p.sessionId === sessionId;
      const sameNameLegacy = !sessionId && p.username === username;
      if (sameTab || sameNameLegacy) { stale.push(existingId); isReconnect = true; }
    }
    for (const existingId of stale) {
      const p = room.participants.get(existingId);
      if (!p) continue;
      console.log(`Evicting stale session for ${username} (${existingId})`);
      try { p.ws.close(4000, 'evicted'); } catch {}
      room.participants.delete(existingId);
      broadcastToRoom(roomId, { type: 'left', username, userId: existingId, reason: 'reconnect' });
    }

    room.participants.set(userId, { ws, username, sessionId, lastHeartbeat: Date.now() });
    if (sessionId) room.recentSessions.set(sessionId, Date.now());
    console.log(`${username} joined room ${roomId}`);

    ws.send(JSON.stringify({ type: 'joined-room', userId, roomId }));

    if (!isReconnect) {
      // Genuinely NEW participant → pause EVERYONE at the current position so the
      // joiner can catch up. Humans resume playback when ready.
      const pauseTime = currentRoomTime(room);
      room.state = { time: pauseTime, paused: true, rate: room.state.rate, lastUpdate: Date.now() };
      broadcastToRoom(roomId, { type: 'sync', action: 'pause', time: pauseTime, rate: room.state.rate });
      broadcastToRoom(roomId, { type: 'joined', username }, userId);
    }

    // Always resync THIS socket to the authoritative position — and once more
    // shortly after, in case the joiner's <video> element wasn't ready yet (e.g.
    // Videasy creates it only on first play).
    const resyncJoiner = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const r = rooms.get(roomId);
      if (!r || !r.participants.has(userId)) return;
      ws.send(JSON.stringify({
        type: 'sync',
        action: r.state.paused ? 'pause' : 'play',
        time: currentRoomTime(r),
        rate: r.state.rate
      }));
    };
    resyncJoiner();
    setTimeout(resyncJoiner, 1500);

    broadcastParticipants(roomId);
  }

  function handleSync(data) {
    const { roomId, action, time, rate, paused } = data;
    const room = rooms.get(roomId);
    if (!room) return;

    // Explicit user action → authoritative. Explicit-undefined checks so a seek to
    // 0:00 (time === 0) is recorded, not dropped by `||`.
    room.state = {
      time: (time !== undefined && time !== null) ? time : room.state.time,
      paused: (paused !== undefined) ? paused : room.state.paused,
      rate: (rate !== undefined && rate !== null) ? rate : room.state.rate,
      lastUpdate: Date.now()
    };

    // Broadcast to everyone EXCEPT the sender (the sender already performed the
    // action locally). `username` is carried through so receivers can show an
    // attribution toast ("Jayesh paused"). Incoming syncs always apply on the
    // receiver regardless of its isSyncing window.
    broadcastToRoom(roomId, { type: 'sync', action, time, rate, paused, username: data.username }, userId);
  }

  // Relay an emoji reaction to the other participants (sender renders its own).
  function handleReaction(data) {
    if (!rooms.has(data.roomId)) return;
    broadcastToRoom(data.roomId, { type: 'reaction', emoji: data.emoji, username: data.username }, userId);
  }

  // A client asks for the current authoritative position (on Sync Now, or once its
  // <video> finally appears). Reply to that one socket.
  function handleRequestSync(data) {
    const room = rooms.get(data.roomId);
    if (!room || !room.participants.has(userId)) return;
    ws.send(JSON.stringify({
      type: 'sync',
      action: room.state.paused ? 'pause' : 'play',
      time: currentRoomTime(room),
      rate: room.state.rate
    }));
  }

  function handleChat(data) {
    const { roomId, username, message } = data;
    if (!rooms.has(roomId)) return;
    broadcastToRoom(roomId, { type: 'chat', username, message });
  }

  // Liveness only — intentionally does NOT touch room.state (see currentRoomTime).
  function handleHeartbeat(data) {
    const room = rooms.get(data.roomId);
    const p = room && room.participants.get(userId);
    if (p) {
      p.lastHeartbeat = Date.now();
      if (currentSessionId) room.recentSessions.set(currentSessionId, Date.now());
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pong' }));
  }

  function handleGetParticipants(data) {
    const room = rooms.get(data.roomId);
    if (!room) return;
    // MUST include the list — the client treats every 'participants' message as
    // authoritative, so a count-only payload would blank everyone's UI.
    ws.send(JSON.stringify({
      type: 'participants',
      count: room.participants.size,
      list: participantList(room)
    }));
  }

  function relayWebRTC(data, type, payload) {
    const room = rooms.get(data.roomId);
    if (!room) return;
    const target = room.participants.get(data.targetUserId);
    if (target && target.ws.readyState === WebSocket.OPEN) {
      target.ws.send(JSON.stringify({ type, fromUserId: userId, ...payload }));
    }
  }

  function handleMicStatus(data) {
    if (!rooms.has(data.roomId)) return;
    broadcastToRoom(data.roomId, { type: 'mic-status-update', userId, muted: data.muted }, userId);
  }

  function handleVideoStatus(data) {
    if (!rooms.has(data.roomId)) return;
    broadcastToRoom(data.roomId, { type: data.type, userId }, userId);
  }
});

// ─── Timers ─────────────────────────────────────────────────────────────────

// Server-initiated WS ping → dead sockets get terminated (which fires 'close' →
// deferred leave → leaveRoom → peers notified). Survives background-tab throttling.
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 25000);

// Secondary safety net: reap participants whose heartbeat/pong stopped. Routes
// through leaveRoom so peers are always notified (the old code deleted silently).
const reapInterval = setInterval(() => {
  const now = Date.now();
  const TIMEOUT = 60000; // generous; WS ping keeps healthy backgrounded tabs alive
  const victims = [];
  rooms.forEach((room, roomId) => {
    room.participants.forEach((p, uid) => {
      if (now - p.lastHeartbeat > TIMEOUT) victims.push({ roomId, userId: uid });
    });
    // Prune old recent-session entries so the map can't grow unbounded.
    if (room.recentSessions) {
      room.recentSessions.forEach((ts, sid) => {
        if (now - ts > RECONNECT_GRACE_MS) room.recentSessions.delete(sid);
      });
    }
  });
  for (const { roomId, userId } of victims) {
    const room = rooms.get(roomId);
    if (!room) continue;
    const p = room.participants.get(userId);
    if (!p) continue;
    console.log(`Removing inactive participant: ${p.username}`);
    try { p.ws.terminate(); } catch {}
    leaveRoom(roomId, userId);
  }
}, 15000);

// Periodic drift correction: nudge every client to the authoritative position so
// small playback drift ("one user is ahead") self-corrects. Only while playing.
const driftInterval = setInterval(() => {
  rooms.forEach((room, roomId) => {
    if (room.participants.size < 2 || room.state.paused) return;
    broadcastToRoom(roomId, {
      type: 'sync',
      action: 'drift',
      time: currentRoomTime(room),
      rate: room.state.rate,
      paused: false
    });
  });
}, 5000);

wss.on('close', () => {
  clearInterval(pingInterval);
  clearInterval(reapInterval);
  clearInterval(driftInterval);
});

// ─── Express routes ─────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.send('WatchTogether Sync Server is running!');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeRooms: rooms.size,
    totalParticipants: Array.from(rooms.values()).reduce((sum, room) => sum + room.participants.size, 0)
  });
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`WatchTogether server listening on ${HOST}:${PORT}`);
});
