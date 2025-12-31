const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ADMIN_PASS = "12345";

let gameState = {
    status: 'waiting', 
    maxNumbers: 100,
    numbers: [],
    calledNumbers: [],
    history: [],
    players: {},
    hasActiveScreen: false, // Nueva bandera
    config: { winnersCount: 3, pricePerChip: 10, speed: 4, voice: 'female' },
    results: { totalPot: 0, winners: [] },
    pendingClaim: null 
};

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// Función auxiliar para verificar si hay pantallas
function checkScreens() {
    const wasActive = gameState.hasActiveScreen;
    gameState.hasActiveScreen = Object.values(gameState.players).some(p => p.role === 'screen');
    // Si cambia el estado, notificamos inmediatamente
    if (wasActive !== gameState.hasActiveScreen) {
        io.emit('sync', gameState);
    }
}

let gameInterval = null;

function runTimer() {
    clearInterval(gameInterval);
    gameInterval = setInterval(() => {
        if (gameState.numbers.length > 0) {
            const n = gameState.numbers.pop();
            gameState.calledNumbers.push(n);
            gameState.history.unshift(n);
            if (gameState.history.length > 5) gameState.history.pop();
            io.emit('new_number', { number: n, voice: gameState.config.voice });
            io.emit('sync', gameState);
        } else {
            clearInterval(gameInterval);
            gameState.status = 'finished';
            io.emit('sync', gameState);
        }
    }, gameState.config.speed * 1000);
}

io.on('connection', (socket) => {
    socket.emit('sync', gameState);

    socket.on('join', (data) => {
        // Validación de Admin
        const hasAdmin = Object.values(gameState.players).some(p => p.role === 'admin');
        if (!hasAdmin && data.role !== 'admin') return socket.emit('error_msg', 'El Administrador debe entrar primero.');

        let isAdmin = (data.role === 'admin' && data.password === ADMIN_PASS);
        if (data.role === 'admin' && !isAdmin) return socket.emit('error_msg', 'Clave incorrecta.');

        gameState.players[socket.id] = { 
            name: data.name, 
            chips: parseInt(data.chips) || 0, 
            role: data.role, // Guardamos el rol exacto (player, admin, screen)
            isAdmin: isAdmin,
            id: socket.id 
        };
        
        checkScreens(); // Verificar si entró una pantalla
        io.emit('sync', gameState);
    });

    socket.on('start_game', (config) => {
        if (!gameState.players[socket.id]?.isAdmin) return;
        
        gameState.config = config;
        gameState.maxNumbers = parseInt(config.maxNumbers);
        gameState.numbers = shuffle(Array.from({ length: gameState.maxNumbers }, (_, i) => i + 1));
        
        gameState.calledNumbers = [];
        gameState.history = [];
        gameState.results.winners = [];
        gameState.status = 'playing';
        
        let totalChips = Object.values(gameState.players).reduce((acc, p) => acc + p.chips, 0);
        let price = parseFloat(config.pricePerChip) || 0;
        gameState.results.totalPot = totalChips * price;
        
        io.emit('sync', gameState);
        runTimer();
    });

    socket.on('claim_lota', () => {
        if (gameState.status !== 'playing') return;
        if (gameState.results.winners.some(w => w.socketId === socket.id)) return;

        clearInterval(gameInterval);
        gameState.status = 'verifying';
        gameState.pendingClaim = { socketId: socket.id, name: gameState.players[socket.id].name };
        
        io.emit('speak_announcement', '¡LOTA!');
        io.emit('sync', gameState);
    });

    socket.on('admin_verify', (approved) => {
        if (!gameState.players[socket.id]?.isAdmin) return;
        
        if (approved && gameState.pendingClaim) {
            const place = gameState.results.winners.length + 1;
            const count = parseInt(gameState.config.winnersCount);
            const phrase = place === 1 ? "Primer Lugar" : place === 2 ? "Segundo Lugar" : "Tercer Lugar";
            io.emit('speak_announcement', phrase);

            let pct = (count == 1) ? 1 : (count == 2 ? (place==1?0.6:0.4) : (place==1?0.5:place==2?0.3:0.2));
            
            gameState.results.winners.push({ 
                name: gameState.pendingClaim.name, 
                prize: gameState.results.totalPot * pct, 
                place,
                socketId: gameState.pendingClaim.socketId
            });

            if (gameState.results.winners.length >= count) {
                gameState.status = 'finished';
                io.emit('speak_announcement', "Juego Terminado");
            } else {
                gameState.status = 'playing';
                runTimer();
            }
        } else {
            io.emit('speak_announcement', "Denegado, continuamos");
            gameState.status = 'playing';
            runTimer();
        }
        gameState.pendingClaim = null;
        io.emit('sync', gameState);
    });

    socket.on('pause_game', () => {
        if (!gameState.players[socket.id]?.isAdmin) return;
        clearInterval(gameInterval);
        gameState.status = 'paused';
        io.emit('sync', gameState);
    });

    socket.on('resume_game', () => {
        if (!gameState.players[socket.id]?.isAdmin) return;
        gameState.status = 'playing';
        runTimer();
        io.emit('sync', gameState);
    });

    socket.on('reset_game', () => {
        if (!gameState.players[socket.id]?.isAdmin) return;
        clearInterval(gameInterval);
        gameState.status = 'waiting';
        gameState.calledNumbers = [];
        gameState.history = [];
        gameState.results.winners = [];
        io.emit('sync', gameState);
    });

    socket.on('disconnect', () => {
        delete gameState.players[socket.id];
        checkScreens(); // Verificar si se fue la pantalla
        io.emit('sync', gameState);
    });
});

app.use(express.static('public'));
server.listen(3000, () => console.log('Lota Server en puerto 3000'));