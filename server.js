// WebSocket server for WatchTogether extension
// This server handles real-time synchronization between clients

const WebSocket = require('ws');
const express = require('express');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store active rooms and their participants
const rooms = new Map();

// Room data structure:
// {
//   roomId: {
//     participants: Map of userId -> { ws, username, lastHeartbeat }
//     state: { time, paused, rate, lastUpdate }
//   }
// }

// WebSocket connection handler
wss.on('connection', (ws) => {
  let userId = generateUserId();
  let currentRoom = null;
  let currentUsername = null;

  console.log(`New connection: ${userId}`);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(ws, userId, data);
    } catch (error) {
      console.error('Error parsing message:', error);
    }
  });

  ws.on('close', () => {
    console.log(`Connection closed: ${userId}`);
    if (currentRoom) {
      leaveRoom(currentRoom, userId);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });

  // Handle incoming messages
  function handleMessage(ws, userId, data) {
    switch (data.type) {
      case 'join':
        currentRoom = data.roomId;
        currentUsername = data.username;
        joinRoom(data.roomId, userId, ws, data.username);
        break;

      case 'sync':
        handleSync(data);
        break;

      case 'chat':
        handleChat(data);
        break;

      case 'heartbeat':
        handleHeartbeat(data);
        break;
      
      case 'get_participants':
        handleGetParticipants(data, ws);
        break;
      
      case 'webrtc-offer':
        handleWebRTCOffer(data, userId);
        break;
      
      case 'webrtc-answer':
        handleWebRTCAnswer(data, userId);
        break;
      
      case 'webrtc-ice-candidate':
        handleWebRTCIceCandidate(data, userId);
        break;
      
      case 'mic-status':
        handleMicStatus(data, userId);
        break;

      case 'video-change':
        handleVideoChange(data, userId);
        break;

      case 'voice-ready':
        handleVoiceReady(data, userId);
        break;
    }
  }

  // Join a room
  function joinRoom(roomId, userId, ws, username) {
    // Check if room exists (to determine if this is first participant)
    const isNewRoom = !rooms.has(roomId);

    if (isNewRoom) {
      rooms.set(roomId, {
        participants: new Map(),
        state: {
          time: 0,
          paused: true,
          rate: 1,
          lastUpdate: Date.now()
        }
      });
    }

    const room = rooms.get(roomId);
    const isFirstParticipant = room.participants.size === 0;

    room.participants.set(userId, {
      ws,
      username,
      lastHeartbeat: Date.now()
    });

    console.log(`${username} joined room ${roomId}`);

    // Send user their own ID and current state
    ws.send(JSON.stringify({
      type: 'joined-room',
      userId: userId,
      roomId: roomId
    }));

    // Send current state to the new participant
    ws.send(JSON.stringify({
      type: 'sync',
      action: room.state.paused ? 'pause' : 'play',
      time: room.state.time,
      rate: room.state.rate
    }));

    // Notify all participants
    broadcastToRoom(roomId, {
      type: 'joined',
      username: username
    });

    // If not the first participant, pause video for everyone to sync
    if (!isFirstParticipant) {
      // Update room state to paused
      room.state.paused = true;

      // Broadcast pause-on-join to ALL participants (including new one)
      const pauseMessage = JSON.stringify({
        type: 'user-joined-pause',
        username: username,
        time: room.state.time,
        rate: room.state.rate
      });

      room.participants.forEach((participant) => {
        if (participant.ws.readyState === WebSocket.OPEN) {
          participant.ws.send(pauseMessage);
        }
      });

      console.log(`Video paused for sync - ${username} joined room ${roomId}`);
    }

    // Send participant count and list
    const participantList = Array.from(room.participants.entries()).map(([id, p]) => ({
      userId: id,
      username: p.username
    }));

    broadcastToRoom(roomId, {
      type: 'participants',
      count: room.participants.size,
      list: participantList
    });
  }

  // Leave a room
  function leaveRoom(roomId, userId) {
    if (!rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    const participant = room.participants.get(userId);

    if (participant) {
      const username = participant.username;
      room.participants.delete(userId);

      console.log(`${username} left room ${roomId}`);

      // Notify remaining participants
      if (room.participants.size > 0) {
        broadcastToRoom(roomId, {
          type: 'left',
          username: username,
          userId: userId
        });

        const participantList = Array.from(room.participants.entries()).map(([id, p]) => ({
          userId: id,
          username: p.username
        }));

        broadcastToRoom(roomId, {
          type: 'participants',
          count: room.participants.size,
          list: participantList
        });
      } else {
        // Delete room if empty
        rooms.delete(roomId);
        console.log(`Room ${roomId} deleted (empty)`);
      }
    }
  }

  // Handle sync events
  function handleSync(data) {
    const { roomId, action, time, rate, paused } = data;

    if (!rooms.has(roomId)) return;

    const room = rooms.get(roomId);

    // Update room state
    room.state = {
      time: time || room.state.time,
      paused: paused !== undefined ? paused : room.state.paused,
      rate: rate || room.state.rate,
      lastUpdate: Date.now()
    };

    // Broadcast sync to all participants except sender
    broadcastToRoom(roomId, {
      type: 'sync',
      action: action,
      time: time,
      rate: rate,
      paused: paused
    }, userId);
  }

  // Handle chat messages
  function handleChat(data) {
    const { roomId, username, message } = data;

    if (!rooms.has(roomId)) return;

    // Broadcast chat to all participants
    broadcastToRoom(roomId, {
      type: 'chat',
      username: username,
      message: message
    });
  }

  // Handle heartbeat
  function handleHeartbeat(data) {
    const { roomId, time, paused, rate } = data;

    if (!rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    const participant = room.participants.get(userId);

    if (participant) {
      participant.lastHeartbeat = Date.now();

      // Update room state with latest info
      room.state.time = time;
      room.state.paused = paused;
      room.state.rate = rate;
      room.state.lastUpdate = Date.now();
    }
  }

  // Handle get participants request
  function handleGetParticipants(data, ws) {
    const { roomId } = data;

    if (!rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    
    // Send participant count to requesting user
    ws.send(JSON.stringify({
      type: 'participants',
      count: room.participants.size
    }));
  }

  // Handle WebRTC offer
  function handleWebRTCOffer(data, fromUserId) {
    const { roomId, targetUserId, offer } = data;
    
    if (!rooms.has(roomId)) return;
    
    const room = rooms.get(roomId);
    const targetParticipant = room.participants.get(targetUserId);
    
    if (targetParticipant && targetParticipant.ws.readyState === WebSocket.OPEN) {
      targetParticipant.ws.send(JSON.stringify({
        type: 'webrtc-offer',
        fromUserId: fromUserId,
        offer: offer
      }));
    }
  }

  // Handle WebRTC answer
  function handleWebRTCAnswer(data, fromUserId) {
    const { roomId, targetUserId, answer } = data;
    
    if (!rooms.has(roomId)) return;
    
    const room = rooms.get(roomId);
    const targetParticipant = room.participants.get(targetUserId);
    
    if (targetParticipant && targetParticipant.ws.readyState === WebSocket.OPEN) {
      targetParticipant.ws.send(JSON.stringify({
        type: 'webrtc-answer',
        fromUserId: fromUserId,
        answer: answer
      }));
    }
  }

  // Handle WebRTC ICE candidate
  function handleWebRTCIceCandidate(data, fromUserId) {
    const { roomId, targetUserId, candidate } = data;
    
    if (!rooms.has(roomId)) return;
    
    const room = rooms.get(roomId);
    const targetParticipant = room.participants.get(targetUserId);
    
    if (targetParticipant && targetParticipant.ws.readyState === WebSocket.OPEN) {
      targetParticipant.ws.send(JSON.stringify({
        type: 'webrtc-ice-candidate',
        fromUserId: fromUserId,
        candidate: candidate
      }));
    }
  }

  // Handle microphone status update
  function handleMicStatus(data, fromUserId) {
    const { roomId, muted } = data;
    
    if (!rooms.has(roomId)) return;
    
    // Broadcast mic status to all other participants
    broadcastToRoom(roomId, {
      type: 'mic-status-update',
      userId: fromUserId,
      muted: muted
    }, fromUserId);
    
    console.log(`User ${fromUserId} mic status: ${muted ? 'muted' : 'unmuted'}`);
  }

  // Handle voice ready (user is ready for WebRTC connections)
  function handleVoiceReady(data, fromUserId) {
    const { roomId } = data;

    if (!rooms.has(roomId)) return;

    console.log(`User ${fromUserId} is ready for voice chat`);

    // Broadcast to all other participants that this user is ready
    broadcastToRoom(roomId, {
      type: 'voice-ready',
      userId: fromUserId
    }, fromUserId);
  }

  // Handle video change (user navigated to different video)
  function handleVideoChange(data, fromUserId) {
    const { roomId, url, username } = data;

    if (!rooms.has(roomId)) return;

    console.log(`User ${username} changed video to: ${url}`);

    // Broadcast video change to all other participants
    broadcastToRoom(roomId, {
      type: 'video-change',
      url: url,
      username: username,
      userId: fromUserId
    }, fromUserId);
  }

  // Broadcast message to all participants in a room
  function broadcastToRoom(roomId, message, excludeUserId = null) {
    if (!rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    const messageStr = JSON.stringify(message);

    room.participants.forEach((participant, id) => {
      if (id !== excludeUserId && participant.ws.readyState === WebSocket.OPEN) {
        participant.ws.send(messageStr);
      }
    });
  }
});

// Clean up inactive participants
setInterval(() => {
  const now = Date.now();
  const TIMEOUT = 30000; // 30 seconds

  rooms.forEach((room, roomId) => {
    room.participants.forEach((participant, userId) => {
      if (now - participant.lastHeartbeat > TIMEOUT) {
        console.log(`Removing inactive participant: ${participant.username}`);
        participant.ws.close();
        room.participants.delete(userId);
      }
    });

    // Delete empty rooms
    if (room.participants.size === 0) {
      rooms.delete(roomId);
      console.log(`Room ${roomId} deleted (inactive)`);
    }
  });
}, 10000); // Check every 10 seconds

// Express routes
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

// Helper function to generate user ID
function generateUserId() {
  return Math.random().toString(36).substring(2, 15);
}

// Start server
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Listen on all interfaces for cloud deployment
server.listen(PORT, HOST, () => {
  console.log(`WatchTogether server listening on ${HOST}:${PORT}`);
  console.log(`WebSocket URL: ws://localhost:${PORT}`);
});
