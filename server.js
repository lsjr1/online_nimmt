const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const socketMap = {}; 
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getPenalties(num) {
    if (num === 55) return 7;
    if (num % 11 === 0) return 5;
    if (num % 10 === 0) return 3;
    if (num % 5 === 0) return 2;
    return 1;
}

function generateDeck() {
    let deck = Array.from({ length: 104 }, (_, i) => ({ value: i + 1, penalties: getPenalties(i + 1) }));
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = '';
    for (let i = 0; i < 5; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('createRoom', (playerName, playerId) => {
        let roomCode = generateRoomCode();
        while (rooms[roomCode]) roomCode = generateRoomCode();

        rooms[roomCode] = {
            players: {}, deck: [], rows: [[], [], [], []], pendingPlays: [],
            phase: 'WAITING', round: 1, maxRounds: 10,
            availableHues: [0, 60, 120, 180, 240, 300] // Base, Yellow, Green, Cyan, Blue, Magenta
        };

        const room = rooms[roomCode];
        const assignedHue = room.availableHues.shift() || 0;

        socket.join(roomCode);
        socketMap[socket.id] = { roomCode, playerId };
        room.players[playerId] = { 
            name: playerName, hand: [], score: 0, ready: false, selectedCard: null, 
            connected: true, socketId: socket.id, hue: assignedHue 
        };
        
        socket.emit('roomJoined', roomCode);
        io.to(roomCode).emit('updateState', sanitizeState(room, playerId));
    });

    socket.on('joinRoom', (roomCode, playerName, playerId) => {
        roomCode = roomCode.toUpperCase();
        const room = rooms[roomCode];
        if (!room) return socket.emit('errorMsg', 'Room not found.');

        if (room.players[playerId]) {
            socket.join(roomCode);
            socketMap[socket.id] = { roomCode, playerId };
            room.players[playerId].connected = true;
            room.players[playerId].socketId = socket.id;
            socket.emit('roomJoined', roomCode);
            return updateAllClients(roomCode);
        }

        if (room.phase !== 'WAITING') return socket.emit('errorMsg', 'Game has already started.');

        const assignedHue = room.availableHues.shift() || 0;
        socket.join(roomCode);
        socketMap[socket.id] = { roomCode, playerId };
        room.players[playerId] = { 
            name: playerName, hand: [], score: 0, ready: false, selectedCard: null, 
            connected: true, socketId: socket.id, hue: assignedHue
        };
        
        socket.emit('roomJoined', roomCode);
        updateAllClients(roomCode);
    });

    socket.on('leaveRoom', (roomCode, playerId) => {
        const room = rooms[roomCode];
        if (room && room.players[playerId]) {
            room.availableHues.push(room.players[playerId].hue); 
            delete room.players[playerId]; 
            socket.leave(roomCode);
            delete socketMap[socket.id];
            
            if (Object.keys(room.players).length === 0) delete rooms[roomCode];
            else updateAllClients(roomCode);
        }
    });

    socket.on('disconnect', () => {
        const info = socketMap[socket.id];
        if (info && rooms[info.roomCode] && rooms[info.roomCode].players[info.playerId]) {
            rooms[info.roomCode].players[info.playerId].connected = false; 
            delete socketMap[socket.id];
            updateAllClients(info.roomCode);
        }
    });

    socket.on('startGame', (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;
        for (const playerId in room.players) room.players[playerId].score = 0;
        room.round = 1;
        startNewRound(roomCode);
    });

    function startNewRound(roomCode) {
        const room = rooms[roomCode];
        if (room.round > room.maxRounds) {
            room.phase = 'GAME_OVER';
            return updateAllClients(roomCode);
        }

        room.phase = 'SHUFFLING';
        room.rows = [[], [], [], []];
        room.pendingPlays = [];
        updateAllClients(roomCode);

        setTimeout(() => {
            room.deck = generateDeck();
            for (let i = 0; i < 4; i++) {
                let card = room.deck.pop();
                card.ownerHue = 0; 
                room.rows[i] = [card];
            }
            for (const playerId in room.players) {
                room.players[playerId].hand = room.deck.splice(0, 7);
                room.players[playerId].hand.sort((a, b) => a.value - b.value);
                room.players[playerId].ready = false;
                room.players[playerId].selectedCard = null;
            }
            room.phase = 'PLAYING';
            updateAllClients(roomCode);
        }, 3000);
    }

    socket.on('playCard', async (roomCode, cardValue, playerId) => {
        const room = rooms[roomCode];
        if (!room || room.phase !== 'PLAYING') return;

        const player = room.players[playerId];
        if (!player || player.ready) return;

        const cardIndex = player.hand.findIndex(c => c.value === cardValue);
        if (cardIndex === -1) return;
        
        const playedCard = player.hand.splice(cardIndex, 1)[0];
        playedCard.ownerHue = player.hue; 
        
        player.selectedCard = playedCard;
        player.ready = true;

        const allPlayers = Object.values(room.players);
        const everyoneReady = allPlayers.filter(p => p.connected).every(p => p.ready);

        if (everyoneReady) {
            room.phase = 'RESOLVING';
            room.pendingPlays = [];
            for (const [id, p] of Object.entries(room.players)) {
                if (p.selectedCard) {
                    room.pendingPlays.push({ playerId: id, card: p.selectedCard });
                    p.selectedCard = null; 
                }
            }
            await resolveTurn(roomCode);
        } else {
            updateAllClients(roomCode);
        }
    });

    async function resolveTurn(roomCode) {
        const room = rooms[roomCode];
        room.pendingPlays.sort((a, b) => a.card.value - b.card.value);
        updateAllClients(roomCode);
        await sleep(2500);

        while (room.pendingPlays.length > 0) {
            const play = room.pendingPlays[0]; 
            let bestRowIndex = -1;
            let smallestDiff = Infinity;

            for (let i = 0; i < 4; i++) {
                const lastCardInRow = room.rows[i][room.rows[i].length - 1];
                if (!lastCardInRow) continue; 
                const diff = play.card.value - lastCardInRow.value;
                if (diff > 0 && diff < smallestDiff) {
                    smallestDiff = diff;
                    bestRowIndex = i;
                }
            }

            io.to(roomCode).emit('playSound', 'lay');

            if (bestRowIndex === -1) {
                let lowestPenalty = Infinity;
                bestRowIndex = 0;
                for (let i = 0; i < 4; i++) {
                    const rowPenalty = room.rows[i].reduce((sum, c) => sum + c.penalties, 0);
                    if (rowPenalty < lowestPenalty) {
                        lowestPenalty = rowPenalty;
                        bestRowIndex = i;
                    }
                }
                if (room.players[play.playerId]) {
                    room.players[play.playerId].score += lowestPenalty;
                    io.to(roomCode).emit('penaltyAlert', { name: room.players[play.playerId].name, points: lowestPenalty });
                }
                room.rows[bestRowIndex] = [play.card];
            } else {
                room.rows[bestRowIndex].push(play.card);
                if (room.rows[bestRowIndex].length === 6) {
                    updateAllClients(roomCode);
                    await sleep(1500); 
                    const rowPenalty = room.rows[bestRowIndex].slice(0, 5).reduce((sum, c) => sum + c.penalties, 0);
                    if (room.players[play.playerId]) {
                        room.players[play.playerId].score += rowPenalty;
                        io.to(roomCode).emit('penaltyAlert', { name: room.players[play.playerId].name, points: rowPenalty });
                    }
                    room.rows[bestRowIndex] = [play.card]; 
                }
            }

            room.pendingPlays.shift();
            updateAllClients(roomCode);
            await sleep(1500); 
        }

        for (const playerId in room.players) room.players[playerId].ready = false;

        const anyPlayer = Object.values(room.players)[0];
        if (anyPlayer && anyPlayer.hand.length === 0) {
            room.round++;
            startNewRound(roomCode);
        } else {
            room.phase = 'PLAYING';
            updateAllClients(roomCode);
        }
    }

    function updateAllClients(roomCode) {
        const room = rooms[roomCode];
        if (!room) return;
        for (const [playerId, player] of Object.entries(room.players)) {
            if (player.connected) io.to(player.socketId).emit('updateState', sanitizeState(room, playerId));
        }
    }

    function sanitizeState(room, requestPlayerId) {
        let displayPlays = [];
        if (room.phase === 'RESOLVING') {
            displayPlays = room.pendingPlays;
        } else {
            for (const [id, p] of Object.entries(room.players)) {
                if (p.ready) {
                    if (id === requestPlayerId) displayPlays.push({ card: p.selectedCard, hidden: false });
                    else displayPlays.push({ card: { value: '?', penalties: 0 }, hidden: true });
                }
            }
        }

        return {
            phase: room.phase, round: room.round, maxRounds: room.maxRounds, rows: room.rows, pendingPlays: displayPlays,
            myHand: room.players[requestPlayerId]?.hand || [],
            myScore: room.players[requestPlayerId]?.score || 0,
            amIReady: room.players[requestPlayerId]?.ready || false, 
            players: Object.entries(room.players).map(([id, p]) => ({
                name: p.name, score: p.score, ready: p.ready, connected: p.connected,
                hue: p.hue, 
                isMe: id === requestPlayerId
            }))
        };
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
