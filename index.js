import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { CLAIM_TYPES, ADJACENCY_MAP, POINTS, DEFAULT_ROUNDS, TURNS_PER_ROUND, MAX_CONSECUTIVE_GOD_ROUNDS } from './shared/constants.js';
import {
  submitClaimRelayed,
  startGameRelayed,
  isRelayerConfigured,
  getRelayerAddress,
  claimTypeToNumber,
  roomCodeToSessionId,
  generatePlayerAddressSync,
} from './relayer.js';

// Feature flag for blockchain integration
const USE_BLOCKCHAIN = process.env.USE_BLOCKCHAIN === 'true';
const RELAYER_CONFIGURED = isRelayerConfigured();

console.log(`[Config] USE_BLOCKCHAIN: ${USE_BLOCKCHAIN}`);
console.log(`[Config] RELAYER_CONFIGURED: ${RELAYER_CONFIGURED}`);
if (RELAYER_CONFIGURED) {
  console.log(`[Config] Relayer address: ${getRelayerAddress()}`);
}

const app = express();
app.use(cors());

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Divine Wrath WebSocket Server',
    port: process.env.PORT || 3001,
    blockchain: {
      enabled: USE_BLOCKCHAIN,
      relayerConfigured: RELAYER_CONFIGURED,
      relayerAddress: RELAYER_CONFIGURED ? getRelayerAddress() : null,
      contractId: process.env.DIVINE_WRATH_CONTRACT_ID || null,
    }
  });
});

// Parse JSON body for API endpoints
app.use(express.json());

const httpServer = createServer(app);
// CORS origins: localhost for dev, FRONTEND_URL env var for production
const corsOrigins = [
  "http://localhost:5173",
  "http://localhost:3000",
  process.env.FRONTEND_URL
].filter(Boolean);

const io = new Server(httpServer, {
  cors: {
    origin: corsOrigins,
    methods: ["GET", "POST"]
  }
});

// Game rooms storage
const rooms = new Map();

// Generate 6-character room code
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excluding confusing chars
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Convert room code to session ID (u32)
// Simple hash: sum of char codes modulo 2^32
function hashRoomCodeToSessionId(roomCode) {
  let hash = 0;
  for (let i = 0; i < roomCode.length; i++) {
    hash = ((hash << 5) - hash + roomCode.charCodeAt(i)) >>> 0;
  }
  return hash;
}

// Create initial room state
function createRoom(hostId, hostName, avatar = null) {
  return {
    code: generateRoomCode(),
    players: [{
      id: hostId,
      name: hostName,
      role: null,      // 'god' or 'mortal'
      position: null,  // 1-9 for mortals
      isHost: true,
      isReady: false,
      avatar: avatar   // Avatar config { color, eyebrows }
    }],
    phase: 'lobby',    // lobby, setup, claiming, deduction, round_transition, ended
    turn: 0,
    currentRound: 1,
    totalRounds: DEFAULT_ROUNDS,
    currentPlayerIndex: 0,
    claims: [],
    attacks: [],
    verificationsRemaining: 2,  // God can verify 2 claims per turn (accumulates)
    scores: {},        // playerId -> PlayerScore
    godHistory: null,  // GodHistory object
    roundWinner: null, // 'god' | 'mortals' | null
    createdAt: Date.now()
  };
}

// Helper to add score entry
function addScore(room, playerId, action, points, round, turn) {
  if (!room.scores[playerId]) return;

  room.scores[playerId].total += points;
  room.scores[playerId].breakdown.push({
    round,
    turn,
    action,
    points,
  });
}

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // Create a new room
  socket.on('create_room', ({ playerName, avatar }) => {
    const room = createRoom(socket.id, playerName, avatar);
    rooms.set(room.code, room);
    socket.join(room.code);

    console.log(`Room created: ${room.code} by ${playerName}`);
    socket.emit('room_created', { roomCode: room.code, room });
  });

  // Join existing room
  socket.on('join_room', ({ roomCode, playerName, avatar }) => {
    const room = rooms.get(roomCode.toUpperCase());

    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    if (room.players.length >= 4) {
      socket.emit('error', { message: 'Room is full' });
      return;
    }

    if (room.phase !== 'lobby') {
      socket.emit('error', { message: 'Game already started' });
      return;
    }

    room.players.push({
      id: socket.id,
      name: playerName,
      role: null,
      position: null,
      isHost: false,
      isReady: false,
      avatar: avatar || null
    });

    socket.join(roomCode.toUpperCase());

    console.log(`${playerName} joined room ${roomCode}`);
    io.to(roomCode.toUpperCase()).emit('room_updated', { room });
  });

  // Player ready toggle
  socket.on('toggle_ready', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.isReady = !player.isReady;
      io.to(roomCode).emit('room_updated', { room });
    }
  });

  // Configure round count (host only, lobby phase)
  socket.on('set_round_config', ({ roomCode, totalRounds }) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'lobby') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isHost) {
      socket.emit('error', { message: 'Only host can configure rounds' });
      return;
    }

    if (![3, 4, 5].includes(totalRounds)) {
      socket.emit('error', { message: 'Invalid round count' });
      return;
    }

    room.totalRounds = totalRounds;
    io.to(roomCode).emit('room_updated', { room });
  });

  // Start game (host only)
  socket.on('start_game', async ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isHost) {
      socket.emit('error', { message: 'Only host can start the game' });
      return;
    }

    if (room.players.length < 4) {
      socket.emit('error', { message: 'Need 4 players to start' });
      return;
    }

    // Assign roles: 1 god, 3 mortals
    const shuffled = [...room.players].sort(() => Math.random() - 0.5);
    shuffled[0].role = 'god';
    shuffled[1].role = 'mortal';
    shuffled[2].role = 'mortal';
    shuffled[3].role = 'mortal';

    const god = shuffled[0];

    // Initialize scores for all players
    room.scores = {};
    room.players.forEach(p => {
      room.scores[p.id] = {
        playerId: p.id,
        playerName: p.name,
        total: 0,
        breakdown: [],
      };
    });

    // Initialize god history
    room.godHistory = {
      playerId: god.id,
      consecutiveRounds: 1,
      hasPenalty: false,
      missedAttacks: 0,
    };

    room.phase = 'setup'; // Mortals choose positions
    room.turn = 1;
    room.currentRound = 1;

    // Generate blockchain session ID
    const sessionId = roomCodeToSessionId(roomCode);
    room.blockchainSessionId = sessionId;

    console.log(`Game started in room ${roomCode}`);

    // Start game on blockchain (async, don't block the game start)
    if (USE_BLOCKCHAIN && RELAYER_CONFIGURED) {
      const god = shuffled.find(p => p.role === 'god');
      const mortals = shuffled.filter(p => p.role === 'mortal');

      console.log(`[Blockchain] Starting game on-chain...`);
      console.log(`[Blockchain] Session ID: ${sessionId}`);
      console.log(`[Blockchain] God: ${god.id}, Mortals: ${mortals.map(m => m.id).join(', ')}`);

      // Don't await - let the game start while blockchain confirms
      startGameRelayed(
        sessionId,
        roomCode,
        god.id,
        mortals.map(m => m.id)
      )
        .then(() => {
          console.log(`[Blockchain] Game ${sessionId} registered on-chain`);
          room.blockchainRegistered = true;
        })
        .catch(err => {
          console.error(`[Blockchain] Failed to register game:`, err.message);
          room.blockchainRegistered = false;
        });
    }

    io.to(roomCode).emit('game_started', { room });
  });

  // Mortal selects position (setup phase)
  socket.on('select_position', ({ roomCode, position }) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'setup') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.role !== 'mortal') return;

    // Check position not taken
    const taken = room.players.some(p => p.position === position);
    if (taken) {
      socket.emit('error', { message: 'Position already taken' });
      return;
    }

    player.position = position;

    // Check if all mortals have positions
    const mortals = room.players.filter(p => p.role === 'mortal');
    const allReady = mortals.every(m => m.position !== null);

    if (allReady) {
      room.phase = 'claiming';
      room.currentPlayerIndex = room.players.findIndex(p => p.role === 'mortal');
    }

    io.to(roomCode).emit('room_updated', { room });

    if (allReady) {
      io.to(roomCode).emit('phase_changed', { phase: 'claiming', room });
    }
  });

  // Submit claim (claiming phase)
  socket.on('submit_claim', ({ roomCode, claimType, claimValue, targetPlayerId, zkProof }) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'claiming') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.role !== 'mortal') return;

    // Check if player is alive (has position)
    if (player.position === null) {
      socket.emit('error', { message: 'Dead players cannot make claims' });
      return;
    }

    // Check if player already made a claim this turn
    const alreadyClaimed = room.claims.some(c => c.playerId === socket.id && c.turn === room.turn);
    if (alreadyClaimed) {
      socket.emit('error', { message: 'You already made a claim this turn' });
      return;
    }

    // Find target player for the claim
    const targetPlayer = room.players.find(p => p.id === targetPlayerId);
    if (!targetPlayer || targetPlayer.role !== 'mortal') {
      socket.emit('error', { message: 'Invalid target player' });
      return;
    }

    // Prevent claiming adjacent to yourself
    if (claimType === CLAIM_TYPES.ADJACENT && targetPlayerId === socket.id) {
      socket.emit('error', { message: 'Cannot claim to be adjacent to yourself' });
      return;
    }

    // Check if this exact claim was already made by anyone
    const duplicateClaim = room.claims.some(
      c => c.targetPlayerId === targetPlayerId &&
           c.claimType === claimType &&
           c.claimValue === claimValue
    );
    if (duplicateClaim) {
      socket.emit('error', { message: 'This claim was already made' });
      return;
    }

    // Store claim WITHOUT verification - God must verify manually using ZK proofs
    // If the mortal made a claim about themselves, they include a ZK proof
    const isSelfClaim = targetPlayerId === socket.id;
    const hasProof = zkProof && zkProof.proof && zkProof.publicSignals;

    const claim = {
      id: `${room.code}-${room.turn}-${socket.id}`,  // Unique claim ID
      playerId: socket.id,
      playerName: player.name,
      targetPlayerId,
      targetPlayerName: targetPlayer.name,
      claimType,
      claimValue,
      verified: false,  // God must verify manually
      isTrue: null,     // Unknown until verified
      turn: room.turn,
      // ZK proof data (stored for later verification by God)
      isSelfClaim,
      zkProof: hasProof ? zkProof : null,
      verifiedOnChain: false,
    };

    if (hasProof) {
      console.log(`[Claim] Claim with ZK proof stored: ${claim.id}`);
    }

    room.claims.push(claim);

    // Move to next mortal or deduction phase
    // Only count ALIVE mortals (position !== null)
    const aliveMortals = room.players.filter(p => p.role === 'mortal' && p.position !== null);
    const claimsThisTurn = room.claims.filter(c => c.turn === room.turn);

    if (claimsThisTurn.length >= aliveMortals.length) {
      room.phase = 'deduction';
      io.to(roomCode).emit('phase_changed', { phase: 'deduction', room });
    }

    io.to(roomCode).emit('claim_submitted', { claim, room });
  });

  // Submit claim with ZK proof to blockchain
  // This is called after the browser generates the proof
  socket.on('submit_claim_blockchain', async ({ roomCode, claimId, proof, publicSignals }) => {
    if (!USE_BLOCKCHAIN || !RELAYER_CONFIGURED) {
      socket.emit('blockchain_result', {
        success: false,
        error: 'Blockchain not enabled or relayer not configured',
        claimId,
      });
      return;
    }

    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit('blockchain_result', { success: false, error: 'Room not found', claimId });
      return;
    }

    const claim = room.claims.find(c => c.id === claimId);
    if (!claim) {
      socket.emit('blockchain_result', { success: false, error: 'Claim not found', claimId });
      return;
    }

    try {
      // Use the session ID stored when game was started
      const sessionId = room.blockchainSessionId;
      if (!sessionId) {
        socket.emit('blockchain_result', {
          success: false,
          error: 'Game not registered on blockchain yet',
          claimId,
        });
        return;
      }

      // Generate the mortal's address (same as when game was started)
      const mortalAddress = generatePlayerAddressSync(roomCode, claim.playerId);

      // Convert claim value to match circuit format:
      // - row/column: UI uses 1-3, circuit uses 0-2
      // - adjacent: UI and circuit both use cell number 1-9
      let claimValueForCircuit = claim.claimValue;
      if (claim.claimType === 'row' || claim.claimType === 'column') {
        claimValueForCircuit = claim.claimValue - 1;
      }

      console.log(`[Blockchain] Submitting claim ${claimId} to contract...`);
      console.log(`[Blockchain] Session: ${sessionId}, Type: ${claim.claimType}, Value: ${claim.claimValue} → ${claimValueForCircuit}`);
      console.log(`[Blockchain] Mortal address: ${mortalAddress}`);

      const result = await submitClaimRelayed(
        sessionId,
        mortalAddress,
        claimTypeToNumber(claim.claimType),
        claimValueForCircuit,
        true, // expectedResult - for now always true
        proof
      );

      console.log(`[Blockchain] Claim ${claimId} submitted successfully:`, result);

      // Mark claim as verified on-chain
      claim.verifiedOnChain = true;
      claim.blockchainResult = result;

      socket.emit('blockchain_result', {
        success: true,
        claimId,
        result,
        transactionHash: 'pending', // Would need to track this
      });

      io.to(roomCode).emit('claim_verified_onchain', { claim, room });

    } catch (error) {
      console.error(`[Blockchain] Error submitting claim ${claimId}:`, error);
      socket.emit('blockchain_result', {
        success: false,
        error: error.message,
        claimId,
      });
    }
  });

  // God verifies a claim using ZK proof
  socket.on('verify_claim', async ({ roomCode, claimId }) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'deduction') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.role !== 'god') {
      socket.emit('error', { message: 'Only God can verify claims' });
      return;
    }

    if (room.verificationsRemaining <= 0) {
      socket.emit('error', { message: 'No verifications remaining this turn' });
      return;
    }

    const claim = room.claims.find(c => c.id === claimId);
    if (!claim) {
      socket.emit('error', { message: 'Claim not found' });
      return;
    }

    if (claim.verified) {
      socket.emit('error', { message: 'Claim already verified' });
      return;
    }

    // Check if this claim has a ZK proof
    if (claim.zkProof && USE_BLOCKCHAIN && RELAYER_CONFIGURED) {
      // Verify on blockchain using ZK proof
      console.log(`[Blockchain] God verifying claim ${claimId} with ZK proof...`);

      try {
        const sessionId = room.blockchainSessionId;
        if (!sessionId) {
          throw new Error('Game not registered on blockchain');
        }

        // Generate the TARGET mortal's address (proof is about target's position)
        const mortalAddress = generatePlayerAddressSync(roomCode, claim.targetPlayerId);

        // Convert claim value for circuit (row/column: 1-3 → 0-2)
        let claimValueForCircuit = claim.claimValue;
        if (claim.claimType === 'row' || claim.claimType === 'column') {
          claimValueForCircuit = claim.claimValue - 1;
        }

        console.log(`[Blockchain] Session: ${sessionId}, Type: ${claim.claimType}, Value: ${claim.claimValue} → ${claimValueForCircuit}`);
        console.log(`[Blockchain] Mortal address: ${mortalAddress}`);

        // Send to blockchain for verification
        const result = await submitClaimRelayed(
          sessionId,
          mortalAddress,
          claimTypeToNumber(claim.claimType),
          claimValueForCircuit,
          claim.zkProof.isTrue,
          claim.zkProof.proof
        );

        console.log(`[Blockchain] Claim ${claimId} verified on-chain: ${result}`);

        claim.verified = true;
        claim.isTrue = claim.zkProof.isTrue; // The proof already tells us the result
        claim.verifiedOnChain = true;

        // Award points for true self-claim
        if (claim.isTrue && claim.isSelfClaim) {
          addScore(room, claim.playerId, 'true_self_claim', POINTS.TRUE_SELF_CLAIM, room.currentRound, room.turn);
        }

        room.verificationsRemaining--;

        io.to(roomCode).emit('claim_verified', {
          claim,
          verificationsRemaining: room.verificationsRemaining,
          room,
          verifiedOnChain: true,
        });

      } catch (err) {
        console.error(`[Blockchain] Error verifying claim ${claimId}:`, err.message);

        // Fallback to local verification if blockchain fails
        console.log(`[Blockchain] Falling back to local verification...`);
        const claimer = room.players.find(p => p.id === claim.playerId);
        const target = room.players.find(p => p.id === claim.targetPlayerId);

        const isTrue = verifyClaim(
          claimer?.position,
          target?.position,
          claim.claimType,
          claim.claimValue
        );

        claim.verified = true;
        claim.isTrue = isTrue;
        claim.verifiedOnChain = false;
        claim.blockchainError = err.message;

        // Award points for true self-claim
        if (claim.isTrue && claim.isSelfClaim) {
          addScore(room, claim.playerId, 'true_self_claim', POINTS.TRUE_SELF_CLAIM, room.currentRound, room.turn);
        }

        room.verificationsRemaining--;

        io.to(roomCode).emit('claim_verified', {
          claim,
          verificationsRemaining: room.verificationsRemaining,
          room,
          verifiedOnChain: false,
          blockchainError: err.message,
        });
      }
    } else {
      // No ZK proof (claim about someone else) - use local verification
      const claimer = room.players.find(p => p.id === claim.playerId);
      const target = room.players.find(p => p.id === claim.targetPlayerId);

      const isTrue = verifyClaim(
        claimer?.position,
        target?.position,
        claim.claimType,
        claim.claimValue
      );

      claim.verified = true;
      claim.isTrue = isTrue;

      // Award points for true self-claim
      if (claim.isTrue && claim.isSelfClaim) {
        addScore(room, claim.playerId, 'true_self_claim', POINTS.TRUE_SELF_CLAIM, room.currentRound, room.turn);
      }

      room.verificationsRemaining--;

      console.log(`God verified claim ${claimId}: ${isTrue} (${room.verificationsRemaining} remaining)`);

      io.to(roomCode).emit('claim_verified', { claim, verificationsRemaining: room.verificationsRemaining, room });
    }
  });

  // God attacks a cell
  socket.on('attack_cell', ({ roomCode, cell }) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'deduction') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.role !== 'god') return;

    const hitPlayer = room.players.find(p => p.position === cell);
    const god = room.players.find(p => p.role === 'god');

    room.attacks.push({
      cell,
      turn: room.turn,
      round: room.currentRound,
      hit: !!hitPlayer,
      victimName: hitPlayer?.name || null
    });

    // === CALCULATE GOD'S POINTS ===
    if (hitPlayer) {
      hitPlayer.position = null; // Dead

      let godPoints = POINTS.GOD_FINDS_MORTAL; // +40

      if (room.godHistory.hasPenalty) {
        godPoints += POINTS.GOD_PENALTY_HIT_BONUS; // +15 additional = 55
      }

      addScore(room, god.id, 'god_find', godPoints, room.currentRound, room.turn);
    } else {
      // Miss
      room.godHistory.missedAttacks++;

      if (room.godHistory.hasPenalty) {
        addScore(room, god.id, 'god_penalty_miss', POINTS.GOD_PENALTY_MISS, room.currentRound, room.turn);
      }
    }

    // === SURVIVAL POINTS (mortals alive at end of turn) ===
    const aliveMortals = room.players.filter(p => p.role === 'mortal' && p.position !== null);
    aliveMortals.forEach(mortal => {
      addScore(room, mortal.id, 'survive_turn', POINTS.MORTAL_SURVIVES_TURN, room.currentRound, room.turn);
    });

    // Emit attack result first
    io.to(roomCode).emit('attack_result', {
      cell,
      hit: !!hitPlayer,
      victimName: hitPlayer?.name,
      room
    });

    // === CHECK END OF ROUND ===
    if (aliveMortals.length === 0) {
      // God killed everyone
      room.roundWinner = 'god';
      handleEndOfRound(room, roomCode, 'god', io);
    } else if (room.turn >= TURNS_PER_ROUND) {
      // Mortals survived all turns
      room.roundWinner = 'mortals';
      handleEndOfRound(room, roomCode, 'mortals', io);
    } else {
      // Continue to next turn
      room.turn++;
      room.phase = 'claiming';
      room.verificationsRemaining += 2;  // Accumulate: +2 per turn
      io.to(roomCode).emit('phase_changed', { phase: 'claiming', room });
    }
  });

  // God makes choice during round transition
  socket.on('god_choice', ({ roomCode, choice }) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'round_transition') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.role !== 'god') {
      socket.emit('error', { message: 'Only God can make this choice' });
      return;
    }

    if (choice === 'stay') {
      // Check if can stay (limit: 3 consecutive if missed attacks)
      const canStay = !(
        room.godHistory.consecutiveRounds >= (MAX_CONSECUTIVE_GOD_ROUNDS - 1) &&
        room.godHistory.missedAttacks > 0
      );

      if (!canStay) {
        socket.emit('error', { message: 'Cannot stay as God for 3 consecutive rounds after missing' });
        return;
      }

      // Stay with penalty
      room.godHistory.hasPenalty = true;
      room.godHistory.consecutiveRounds++;
      room.godHistory.missedAttacks = 0; // Reset for next round

      // Respawn mortals (god stays god)
      startNextRound(room, roomCode, player.id, io);

    } else if (choice === 'cede') {
      // Cede god role
      startNextRound(room, roomCode, null, io); // null = choose new god randomly
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);

    // Find and clean up rooms
    for (const [code, room] of rooms.entries()) {
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        room.players.splice(playerIndex, 1);

        if (room.players.length === 0) {
          rooms.delete(code);
          console.log(`Room ${code} deleted (empty)`);
        } else {
          // Assign new host if needed
          if (!room.players.some(p => p.isHost)) {
            room.players[0].isHost = true;
          }
          io.to(code).emit('player_left', { room });
        }
      }
    }
  });
});

// Handle end of round - check if game ends or transition
function handleEndOfRound(room, roomCode, winner, io) {
  // Check if this is the last round
  if (room.currentRound >= room.totalRounds) {
    // GAME OVER
    room.phase = 'ended';

    // Calculate final ranking
    const ranking = Object.values(room.scores)
      .sort((a, b) => b.total - a.total);

    io.to(roomCode).emit('game_ended', {
      winner: ranking[0]?.playerId || null,
      ranking,
      room,
      isFinalRound: true,
    });
    return;
  }

  // More rounds to play - go to transition
  room.phase = 'round_transition';
  room.roundWinner = winner;

  if (winner === 'mortals') {
    // Case A: Mortals survived - automatic transition
    io.to(roomCode).emit('round_ended', {
      room,
      winner: 'mortals',
      needsGodChoice: false,
    });

    // Auto-start next round after short delay
    setTimeout(() => {
      if (room.phase === 'round_transition') {
        startNextRound(room, roomCode, null, io);
      }
    }, 3000);

  } else {
    // Case B: God killed everyone - god must choose
    const god = room.players.find(p => p.role === 'god');

    // Check if god CAN stay (limit: 3 consecutive if missed)
    const canStay = !(
      room.godHistory.consecutiveRounds >= (MAX_CONSECUTIVE_GOD_ROUNDS - 1) &&
      room.godHistory.missedAttacks > 0
    );

    io.to(roomCode).emit('round_ended', {
      room,
      winner: 'god',
      needsGodChoice: true,
      canStay,
      godPlayerId: god.id,
    });
  }
}

// Start the next round
function startNextRound(room, roomCode, keepGodId, io) {
  room.currentRound++;
  room.turn = 1;
  room.roundWinner = null;
  room.verificationsRemaining = 2;

  // Clear claims and attacks from previous round
  room.claims = [];
  room.attacks = [];

  if (keepGodId) {
    // God stays (Case B - chose "stay")
    // Only reset mortal positions
    room.players.forEach(p => {
      if (p.role === 'mortal') {
        p.position = null; // Need to reselect position
      }
    });
    // missedAttacks already reset in god_choice handler
  } else {
    // Change god (Case A or Case B with "cede")
    const currentGod = room.players.find(p => p.role === 'god');
    const aliveMortals = room.players.filter(p => p.role === 'mortal' && p.position !== null);

    // Choose new god candidates
    let newGodCandidates;
    if (aliveMortals.length > 0) {
      // Case A: pick from survivors
      newGodCandidates = aliveMortals;
    } else {
      // Case B cede: pick from all except current god
      newGodCandidates = room.players.filter(p => p.id !== currentGod.id);
    }

    const newGod = newGodCandidates[Math.floor(Math.random() * newGodCandidates.length)];

    // Swap roles
    currentGod.role = 'mortal';
    currentGod.position = null;
    newGod.role = 'god';
    newGod.position = null; // God has no position

    // Reset all mortal positions
    room.players.forEach(p => {
      if (p.role === 'mortal') {
        p.position = null;
      }
    });

    // Update god history
    room.godHistory = {
      playerId: newGod.id,
      consecutiveRounds: 1,
      hasPenalty: false,
      missedAttacks: 0,
    };
  }

  room.phase = 'setup';
  io.to(roomCode).emit('round_started', { room, roundNumber: room.currentRound });
}

// Verify claim locally (placeholder for ZK)
function verifyClaim(claimerPosition, targetPosition, claimType, claimValue) {
  if (targetPosition === null) return false;

  const targetRow = Math.ceil(targetPosition / 3);
  const targetCol = ((targetPosition - 1) % 3) + 1;

  switch (claimType) {
    case CLAIM_TYPES.ROW:
      return targetRow === claimValue;
    case CLAIM_TYPES.COLUMN:
      return targetCol === claimValue;
    case CLAIM_TYPES.ADJACENT:
      if (claimerPosition === null) return false;
      return ADJACENCY_MAP[claimerPosition]?.includes(targetPosition) || false;
    default:
      return false;
  }
}

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Divine Wrath server running on port ${PORT}`);
});
