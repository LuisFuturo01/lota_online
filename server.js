const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ADMIN_PASS = "12345";

let gameState = {
    status: 'waiting', // waiting, playing, verifying, finished
    maxNumbers: 100,
    numbers: [],
    calledNumbers: [],
    history: [],
    players: {},
    config: { winnersCount: 3, pricePerChip: 10, speed: 4 },
    results: { totalPot: 0, winners: [] },
    pendingClaim: null // Para la validación del admin
};

function initGame(max) {
    gameState.maxNumbers = max;
    gameState.numbers = Array.from({ length: max }, (_, i) => i + 1);
    for (let i = gameState.numbers.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [gameState.numbers[i], gameState.numbers[j]] = [gameState.numbers[j], gameState.numbers[i]];
    }
}

let gameInterval = null;

io.on('connection', (socket) => {
    socket.emit('sync', gameState);

    socket.on('join', (data) => {
        const hasAdmin = Object.values(gameState.players).some(p => p.isAdmin);
        if (!hasAdmin && data.role !== 'admin') return socket.emit('error_msg', 'El Administrador debe entrar primero.');

        let isAdmin = data.role === 'admin' && data.password === ADMIN_PASS;
        if (data.role === 'admin' && !isAdmin) return socket.emit('error_msg', 'Clave incorrecta.');

        gameState.players[socket.id] = { name: data.name, chips: parseInt(data.chips) || 0, isAdmin, id: socket.id };
        io.emit('sync', gameState);
    });

    socket.on('start_game', (config) => {
        if (!gameState.players[socket.id]?.isAdmin) return;
        gameState.config = config;
        initGame(parseInt(config.maxNumbers));
        gameState.calledNumbers = [];
        gameState.history = [];
        gameState.results.winners = [];
        gameState.status = 'playing';
        
        let totalChips = Object.values(gameState.players).reduce((acc, p) => acc + p.chips, 0);
        gameState.results.totalPot = totalChips * config.pricePerChip;
        
        io.emit('sync', gameState);
        runTimer();
    });

    socket.on('claim_lota', () => {
        if (gameState.status !== 'playing') return;
        const player = gameState.players[socket.id];
        
        clearInterval(gameInterval);
        gameState.status = 'verifying';
        gameState.pendingClaim = { socketId: socket.id, name: player.name };
        
        io.emit('sync', gameState);
        io.emit('notify_claim', player.name);
    });

    socket.on('admin_verify', (approved) => {
        if (!gameState.players[socket.id]?.isAdmin) return;
        
        if (approved && gameState.pendingClaim) {
            const place = gameState.results.winners.length + 1;
            const count = parseInt(gameState.config.winnersCount);
            let pct = (count === 1) ? 1 : (count === 2 ? (place===1?0.6:0.4) : (place===1?0.5:place===2?0.3:0.2));
            
            gameState.results.winners.push({
                name: gameState.pendingClaim.name,
                prize: gameState.results.totalPot * pct,
                place
            });

            if (gameState.results.winners.length >= count) {
                gameState.status = 'finished';
            } else {
                gameState.status = 'playing';
                runTimer();
            }
        } else {
            gameState.status = 'playing';
            runTimer();
        }
        
        gameState.pendingClaim = null;
        io.emit('sync', gameState);
    });

    socket.on('reset_game', () => {
        if (!gameState.players[socket.id]?.isAdmin) return;
        clearInterval(gameInterval);
        gameState.status = 'waiting';
        gameState.results.winners = [];
        io.emit('sync', gameState);
    });

    function runTimer() {
        clearInterval(gameInterval);
        gameInterval = setInterval(() => {
            if (gameState.numbers.length > 0) {
                const n = gameState.numbers.pop();
                gameState.calledNumbers.push(n);
                gameState.history.unshift(n);
                if (gameState.history.length > 5) gameState.history.pop();
                io.emit('new_number', n);
                io.emit('sync', gameState);
            } else {
                clearInterval(gameInterval);
                gameState.status = 'finished';
                io.emit('sync', gameState);
            }
        }, gameState.config.speed * 1000);
    }

    socket.on('disconnect', () => {
        delete gameState.players[socket.id];
        io.emit('sync', gameState);
    });
});

server.listen(3000, () => console.log('Lota Pro en http://localhost:3000'));
app.use(express.static('public'));