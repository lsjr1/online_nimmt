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

const colorFilters = {
    "Red": "none",
    "Yellow": "hue-rotate(71deg) brightness(2.5) saturate(0.8) contrast(2.2)",
    "Green": "hue-rotate(120deg)",
    "Turquoise": "hue-rotate(180deg) brightness(2)",
    "Dark Blue": "hue-rotate(240deg) brightness(0.6) saturate(1.2)",
    "Pink": "hue-rotate(320deg) brightness(1.2) saturate(0.8)",
    "Purple": "hue-rotate(270deg) saturate(0.8)",
    "Brown": "hue-rotate(30deg) grayscale(20%) brightness(0.5)",
    "Silver": "grayscale(100%) brightness(1.2) contrast(0.9)",
    "Grey": "grayscale(100%) brightness(0.5) contrast(1.2)"
};

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

    socket.on('createRoom', (playerName, playerId, colorChoice) => {
        let roomCode = generateRoomCode();
        while (rooms[roomCode]) roomCode = generateRoomCode();

        rooms[roomCode] = {
            players: {}, deck: [], rows: [[], [], [], []], pendingPlays: [],
            phase: 'WAITING', round: 1, maxRounds: 10, currentRoundStats: {}
        };

        const room = rooms[roomCode];
        const cssFilter = colorFilters[colorChoice] || "none";

        socket.join(roomCode);
        socketMap[socket.id] = { roomCode, playerId };
        room.players[playerId] = { 
            name: playerName, hand: [], score: 0, ready: false, selectedCard: null, 
            connected: true, socketId: socket.id, cssFilter: cssFilter, bets: {} 
        };
        
        socket.emit('roomJoined', roomCode);
        io.to(roomCode).emit('updateState', sanitizeState(room, playerId));
    });

    socket.on('joinRoom', (roomCode, playerName, playerId, colorChoice) => {
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

        const cssFilter = colorFilters[colorChoice] || "none";
        
        socket.join(roomCode);
        socketMap[socket.id] = { roomCode, playerId };
        room.players[playerId] = { 
            name: playerName, hand: [], score: 0, ready: false, selectedCard: null, 
            connected: true, socketId: socket.id, cssFilter: cssFilter, bets: {}
        };
        
        socket.emit('roomJoined', roomCode);
        updateAllClients(roomCode);
    });

    socket.on('leaveRoom', (roomCode, playerId) => {
        const room = rooms[roomCode];
        if (room && room.players[playerId]) {
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
            let initialMax = 0;
            let initialMin = 105;

            for (let i = 0; i < 4; i++) {
                let card = room.deck.pop();
                card.ownerFilter = "none"; 
                room.rows[i] = [card];
                if(card.value > initialMax) initialMax = card.value;
                if(card.value < initialMin) initialMin = card.value;
            }

            room.currentRoundStats = { playerPoints: {}, highestCard: initialMax, lowestCard: initialMin };

            for (const playerId in room.players) {
                room.players[playerId].hand = room.deck.splice(0, 7);
                room.players[playerId].hand.sort((a, b) => a.value - b.value);
                room.players[playerId].ready = false;
                room.players[playerId].selectedCard = null;
                room.players[playerId].bets = {}; // Clear old bets
                room.currentRoundStats.playerPoints[playerId] = 0; // Initialize round points
            }
            
            room.phase = 'BETTING';
            updateAllClients(roomCode);
        }, 3000);
    }

    // --- Side Bet Processing ---
    socket.on('submitBets', (roomCode, playerId, bets) => {
        const room = rooms[roomCode];
        if (!room || room.phase !== 'BETTING') return;
        const player = room.players[playerId];
        if (!player) return;

        player.bets = bets;
        player.ready = true;

        const allPlayers = Object.values(room.players).filter(p => p.connected);
        if (allPlayers.every(p => p.ready)) {
            room.phase = 'PLAYING';
            allPlayers.forEach(p => p.ready = false);
            updateAllClients(roomCode);
        } else {
            updateAllClients(roomCode);
        }
    });

    socket.on('playCard', async (roomCode, cardValue, playerId) => {
        const room = rooms[roomCode];
        if (!room || room.phase !== 'PLAYING') return;

        const player = room.players[playerId];
        if (!player || player.ready) return;

        const cardIndex = player.hand.findIndex(c => c.value === cardValue);
        if (cardIndex === -1) return;
        
        const playedCard = player.hand.splice(cardIndex, 1)[0];
        playedCard.ownerFilter = player.cssFilter; 
        
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

            // Track stats for side bets
            if (play.card.value > room.currentRoundStats.highestCard) room.currentRoundStats.highestCard = play.card.value;
            if (play.card.value < room.currentRoundStats.lowestCard) room.currentRoundStats.lowestCard = play.card.value;

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
                    room.currentRoundStats.playerPoints[play.playerId] += lowestPenalty; // Track round pts
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
                        room.currentRoundStats.playerPoints[play.playerId] += rowPenalty; // Track round pts
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
            resolveBetsAndEndRound(roomCode);
        } else {
            room.phase = 'PLAYING';
            updateAllClients(roomCode);
        }
    }

    function resolveBetsAndEndRound(roomCode) {
        const room = rooms[roomCode];
        room.phase = 'BET_RESULTS';
        
        let maxPts = -1, minPts = Infinity;
        let maxPlayers = [], minPlayers = [];

        // Determine Highest/Lowest point collectors of the round
        for (let id in room.currentRoundStats.playerPoints) {
            let pts = room.currentRoundStats.playerPoints[id];
            if (pts > maxPts) { maxPts = pts; maxPlayers = [id]; } 
            else if (pts === maxPts) { maxPlayers.push(id); }

            if (pts < minPts) { minPts = pts; minPlayers = [id]; } 
            else if (pts === minPts) { minPlayers.push(id); }
        }

        let summary = [];

        // Payout Bets
        for (let id in room.players) {
            let p = room.players[id];
            let betLog = [];
            let netChange = 0;

            if (p.bets) {
                if (p.bets.highColl && p.bets.highColl.stake > 0) {
                    if (maxPlayers.includes(p.bets.highColl.id)) {
                        netChange -= p.bets.highColl.stake;
                        betLog.push(`✅ Won -${p.bets.highColl.stake} (Highest Collector)`);
                    } else {
                        netChange += p.bets.highColl.stake;
                        betLog.push(`❌ Lost +${p.bets.highColl.stake} (Highest Collector)`);
                    }
                }
                if (p.bets.lowColl && p.bets.lowColl.stake > 0) {
                    if (minPlayers.includes(p.bets.lowColl.id)) {
                        netChange -= p.bets.lowColl.stake;
                        betLog.push(`✅ Won -${p.bets.lowColl.stake} (Lowest Collector)`);
                    } else {
                        netChange += p.bets.lowColl.stake;
                        betLog.push(`❌ Lost +${p.bets.lowColl.stake} (Lowest Collector)`);
                    }
                }
                if (p.bets.highCard && p.bets.highCard.stake > 0) {
                    if (p.bets.highCard.val === room.currentRoundStats.highestCard) {
                        netChange -= p.bets.highCard.stake;
                        betLog.push(`✅ Won -${p.bets.highCard.stake} (Highest Card: ${room.currentRoundStats.highestCard})`);
                    } else {
                        netChange += p.bets.highCard.stake;
                        betLog.push(`❌ Lost +${p.bets.highCard.stake} (Highest Card was ${room.currentRoundStats.highestCard})`);
                    }
                }
                if (p.bets.lowCard && p.bets.lowCard.stake > 0) {
                    if (p.bets.lowCard.val === room.currentRoundStats.lowestCard) {
                        netChange -= p.bets.lowCard.stake;
                        betLog.push(`✅ Won -${p.bets.lowCard.stake} (Lowest Card: ${room.currentRoundStats.lowestCard})`);
                    } else {
                        netChange += p.bets.lowCard.stake;
                        betLog.push(`❌ Lost +${p.bets.lowCard.stake} (Lowest Card was ${room.currentRoundStats.lowestCard})`);
                    }
                }
            }

            p.score += netChange;
            if (betLog.length > 0) {
                summary.push({ name: p.name, netChange, log: betLog });
            }
        }

        io.to(roomCode).emit('showBetResults', {
            highCollectors: maxPlayers.map(id => room.players[id].name).join(', '),
            lowCollectors: minPlayers.map(id => room.players[id].name).join(', '),
            highCard: room.currentRoundStats.highestCard,
            lowCard: room.currentRoundStats.lowestCard,
            summary: summary
        });

        updateAllClients(roomCode);

        // Pause for 10 seconds to read results, then shuffle for next round
        setTimeout(() => {
            room.round++;
            startNewRound(roomCode);
        }, 10000);
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
                if (p.ready && room.phase === 'PLAYING') {
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
                id: id, name: p.name, score: p.score, ready: p.ready, connected: p.connected,
                cssFilter: p.cssFilter, 
                isMe: id === requestPlayerId
            }))
        };
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
