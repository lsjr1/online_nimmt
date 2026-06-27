const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "https://online-nimmt.onrender.com", 
        methods: ["GET", "POST"]
    }
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getPenalties(num) {
    if (num === 55) return 7;
    if (num % 11 === 0) return 5;
    if (num % 10 === 0) return 3;
    if (num % 5 === 0) return 2;
    return 1;
}

function generateDeck() {
    let deck = Array.from({ length: 104 }, (_, i) => ({
        value: i + 1,
        penalties: getPenalties(i + 1)
    }));
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = '';
    for (let i = 0; i < 5; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Host Game Logic
    socket.on('createRoom', (playerName) => {
        let roomCode = generateRoomCode();
        // Ensure unique code
        while (rooms[roomCode]) {
            roomCode = generateRoomCode();
        }

        rooms[roomCode] = {
            players: {},
            deck: [],
            rows: [[], [], [], []],
            pendingPlays: [],
            phase: 'WAITING',
            round: 1,
            maxRounds: 10
        };

        socket.join(roomCode);
        rooms[roomCode].players[socket.id] = { name: playerName, hand: [], score: 0, ready: false, selectedCard: null };
        
        // Notify client of success and send room code
        socket.emit('roomJoined', roomCode);
        io.to(roomCode).emit('updateState', sanitizeState(rooms[roomCode], socket.id));
    });

    // Join Game Logic
    socket.on('joinRoom', (roomCode, playerName) => {
        roomCode = roomCode.toUpperCase();
        
        if (!rooms[roomCode]) {
            socket.emit('errorMsg', 'Room not found. Check the code and try again.');
            return;
        }
        if (rooms[roomCode].phase !== 'WAITING') {
            socket.emit('errorMsg', 'Game has already started.');
            return;
        }

        socket.join(roomCode);
        rooms[roomCode].players[socket.id] = { name: playerName, hand: [], score: 0, ready: false, selectedCard: null };
        
        socket.emit('roomJoined', roomCode);
        updateAllClients(roomCode);
    });

    socket.on('startGame', (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;
        
        for (const playerId in room.players) {
            room.players[playerId].score = 0;
        }
        room.round = 1;
        startNewRound(roomCode);
    });

    function startNewRound(roomCode) {
        const room = rooms[roomCode];
        if (room.round > room.maxRounds) {
            room.phase = 'GAME_OVER';
            updateAllClients(roomCode);
            return;
        }

        room.phase = 'SHUFFLING';
        room.rows = [[], [], [], []];
        room.pendingPlays = [];
        updateAllClients(roomCode);

        setTimeout(() => {
            room.deck = generateDeck();
            
            for (let i = 0; i < 4; i++) {
                room.rows[i] = [room.deck.pop()];
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

    socket.on('playCard', async (roomCode, cardValue) => {
        const room = rooms[roomCode];
        if (!room || room.phase !== 'PLAYING') return;

        const player = room.players[socket.id];
        if (player.ready) return;

        const cardIndex = player.hand.findIndex(c => c.value === cardValue);
        if (cardIndex === -1) return;
        
        const playedCard = player.hand.splice(cardIndex, 1)[0];
        player.selectedCard = playedCard;
        player.ready = true;

        const allPlayers = Object.values(room.players);
        const everyoneReady = allPlayers.every(p => p.ready);

        if (everyoneReady) {
            room.phase = 'RESOLVING';
            room.pendingPlays = [];
            
            for (const [id, p] of Object.entries(room.players)) {
                room.pendingPlays.push({ playerId: id, card: p.selectedCard });
                p.selectedCard = null; 
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
                    }
                    room.rows[bestRowIndex] = [play.card]; 
                }
            }

            room.pendingPlays.shift();
            updateAllClients(roomCode);
            await sleep(1500); 
        }

        for (const playerId in room.players) {
            room.players[playerId].ready = false;
        }

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
        for (const playerId in room.players) {
            io.to(playerId).emit('updateState', sanitizeState(room, playerId));
        }
    }

    function sanitizeState(room, socketId) {
        let displayPlays = [];
        
        if (room.phase === 'RESOLVING') {
            displayPlays = room.pendingPlays;
        } else {
            for (const [id, p] of Object.entries(room.players)) {
                if (p.ready) {
                    if (id === socketId) {
                        displayPlays.push({ card: p.selectedCard, hidden: false });
                    } else {
                        displayPlays.push({ card: { value: '?', penalties: 0 }, hidden: true });
                    }
                }
            }
        }

        return {
            phase: room.phase,
            round: room.round,
            maxRounds: room.maxRounds,
            rows: room.rows,
            pendingPlays: displayPlays,
            myHand: room.players[socketId]?.hand || [],
            myScore: room.players[socketId]?.score || 0,
            players: Object.entries(room.players).map(([id, p]) => ({
                name: p.name,
                score: p.score,
                ready: p.ready,
                cardsLeft: p.hand.length
            }))
        };
    }
});

server.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
});
