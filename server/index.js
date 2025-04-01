// Server to manage computer connections and relay webcam streams
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Store connected computers
const connectedComputers = new Map();

// API routes
app.get('/api/computers', (req, res) => {
    const computers = Array.from(connectedComputers.values()).map(computer => ({
        id: computer.id,
        name: computer.name,
        ip: computer.ip,
        status: 'online',
        lastSeen: computer.lastSeen
    }));

    res.json(computers);
});

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('New connection:', socket.id);
    let computerInfo = null;

    // Computer registration
    socket.on('register-computer', (data) => {
        computerInfo = {
            id: socket.id,
            name: data.name,
            ip: socket.handshake.address,
            lastSeen: new Date(),
            capabilities: data.capabilities || {}
        };

        connectedComputers.set(socket.id, computerInfo);
        console.log(`Computer registered: ${data.name}`);

        // Broadcast updated computer list
        io.emit('computers-updated');
    });

    // Stream data relay
    socket.on('webcam-frame', (data) => {
        // Relay the webcam frame to viewers
        io.to(data.viewerId).emit('webcam-frame', {
            frame: data.frame,
            computerId: socket.id
        });

        // Update last seen timestamp
        if (computerInfo) {
            computerInfo.lastSeen = new Date();
            connectedComputers.set(socket.id, computerInfo);
        }
    });

    // Handle stream requests
    socket.on('request-stream', (data) => {
        const { computerId } = data;
        const targetComputer = connectedComputers.get(computerId);

        if (targetComputer) {
            // Notify computer to start streaming to this viewer
            io.to(computerId).emit('start-stream', {
                viewerId: socket.id
            });

            socket.emit('stream-ready', {
                computerName: targetComputer.name
            });
        } else {
            socket.emit('stream-error', {
                message: 'Computer is not connected'
            });
        }
    });

    // Handle stream stop requests
    socket.on('stop-stream', (data) => {
        const { computerId } = data;
        if (computerId) {
            io.to(computerId).emit('stop-stream', {
                viewerId: socket.id
            });
        }
    });

    // Disconnection handling
    socket.on('disconnect', () => {
        if (computerInfo) {
            console.log(`Computer disconnected: ${computerInfo.name}`);
            connectedComputers.delete(socket.id);
            // Broadcast updated computer list
            io.emit('computers-updated');
        }
    });
});

// Periodically clean up stale connections (computers that haven't sent data for 1 minute)
setInterval(() => {
    const now = new Date();
    for (const [id, computer] of connectedComputers.entries()) {
        const timeDiff = now - computer.lastSeen;
        if (timeDiff > 60000) { // 1 minute
            console.log(`Computer connection timed out: ${computer.name}`);
            connectedComputers.delete(id);
            io.emit('computers-updated');
        }
    }
}, 30000); // Check every 30 seconds

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});