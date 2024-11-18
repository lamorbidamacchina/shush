const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const cssPath = path.join(__dirname, 'public', 'styles.css');
const fs = require('fs');
fs.access(cssPath, fs.constants.F_OK, (err) => {
    if (err) {
        console.error(err);
    } 
});

// Serve static files with correct MIME types
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, path, stat) => {
      if (path.endsWith('.css')) {
          res.set('Content-Type', 'text/css');
      }
  }
}));

// Serve static files from the public folder
app.use(express.static(path.join(__dirname, 'public')));

// Mappa per tenere traccia degli utenti connessi
const connectedUsers = new Map();

// List of names
const firstNames = [
    'Red', 'Blue', 'Green', 'Yellow', 'Purple', 'Orange', 'White', 'Black',
    'Moon', 'Sun', 'Star', 'Wind', 'Sea', 'Mountain', 'River', 'Forest',
    // ... add more names until reaching about 50 words ...
];

const secondNames = [
    'Wolf', 'Eagle', 'Lion', 'Tiger', 'Bear', 'Falcon', 'Dolphin', 'Fox',
    'Dragon', 'Phoenix', 'Unicorn', 'Griffin', 'Panther', 'Owl', 'Snake',
    // ... add more names until reaching about 50 words ...
];

// Random name generator function
function generateRandomName() {
    const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
    const secondName = secondNames[Math.floor(Math.random() * secondNames.length)];
    return `${firstName}${secondName}`;
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('New connected user:', socket.id);

    // User registration handling
    socket.on('register', (publicKey) => {
        const displayName = generateRandomName();
        console.log('User registered:', displayName, '(', socket.id, ')');
        connectedUsers.set(socket.id, {
            socketId: socket.id,
            publicKey: publicKey,
            displayName: displayName
        });
        
        // Send updated list to all
        io.emit('users-update', Array.from(connectedUsers.values()));
    });

    // Private message handling
    socket.on('private-message', ({ to, encryptedMessage }) => {
        const sender = connectedUsers.get(socket.id);
        if (sender && connectedUsers.has(to)) {
            io.to(to).emit('private-message', {
                from: socket.id,
                fromName: sender.displayName,
                encryptedMessage: encryptedMessage
            });
        }
    });

    // Disconnection handling
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        connectedUsers.delete(socket.id);
        io.emit('users-update', Array.from(connectedUsers.values()));
    });
});

// Server listening
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});