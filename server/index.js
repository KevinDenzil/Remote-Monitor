// Server to manage computer connections and relay webcam streams
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json()); // Add this to parse JSON request bodies

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Store connected computers
const connectedComputers = new Map();

// Store registered computers (including offline ones)
const registeredComputers = new Map();

// Store connection codes for pairing
const connectionCodes = new Map();

// API routes
app.get('/api/computers', (req, res) => {
    // Get all computers (both online and registered but offline)
    const allComputers = [];

    // First add all online computers
    for (const computer of connectedComputers.values()) {
        allComputers.push({
            id: computer.id,
            name: computer.name,
            ip: computer.ip,
            status: 'online',
            lastSeen: computer.lastSeen
        });
    }

    // Then add registered but offline computers
    for (const [id, computer] of registeredComputers.entries()) {
        // Skip if already in the list (online)
        if (!connectedComputers.has(id)) {
            allComputers.push({
                id: computer.id,
                name: computer.name,
                ip: computer.ip || 'unknown',
                status: 'offline',
                lastSeen: computer.lastSeen
            });
        }
    }

    res.json(allComputers);
});

// Register a new computer
app.post('/api/computers/register', (req, res) => {
    const { name, connectionCode } = req.body;

    if (!name || !connectionCode) {
        return res.status(400).json({ message: 'Computer name and connection code are required' });
    }

    // Generate a unique ID for the computer
    const computerId = `reg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    // Store the computer in the registered computers map
    registeredComputers.set(computerId, {
        id: computerId,
        name,
        status: 'offline',
        lastSeen: new Date(),
        connectionCode
    });

    // Store the connection code for pairing
    connectionCodes.set(connectionCode, computerId);

    console.log(`Computer registered: ${name} with code ${connectionCode}`);

    // Broadcast updated computer list
    io.emit('computers-updated');

    return res.status(201).json({
        message: 'Computer registered successfully',
        id: computerId
    });
});

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('New connection:', socket.id);
    let computerInfo = null;

    // Computer registration
    socket.on('register-computer', (data) => {
        let id = socket.id;

        // Check if this is a reconnection of a registered computer using connection code
        if (data.connectionCode && connectionCodes.has(data.connectionCode)) {
            const registeredId = connectionCodes.get(data.connectionCode);

            if (registeredComputers.has(registeredId)) {
                // Update the socket ID but keep the registered ID
                id = registeredId;
                const registered = registeredComputers.get(registeredId);
                data.name = registered.name; // Use the registered name
            }
        }

        computerInfo = {
            id: id,
            name: data.name,
            ip: socket.handshake.address,
            lastSeen: new Date(),
            capabilities: data.capabilities || {},
            connectionCode: data.connectionCode
        };

        connectedComputers.set(socket.id, computerInfo);

        // If this is a registered computer, update its status
        if (registeredComputers.has(id)) {
            registeredComputers.set(id, {
                ...registeredComputers.get(id),
                status: 'online',
                lastSeen: new Date()
            });
        }

        console.log(`Computer registered: ${data.name}`);

        // Broadcast updated computer list
        io.emit('computers-updated');
    });

    // Computer pairing
    socket.on('pair-computer', (data) => {
        if (data.connectionCode && connectionCodes.has(data.connectionCode)) {
            const computerId = connectionCodes.get(data.connectionCode);
            socket.emit('computer-paired', { computerId });
        } else {
            socket.emit('pair-error', { message: 'Invalid connection code' });
        }
    });

    // Stream data relay
    socket.on('webcam-frame', (data) => {
        const { viewerId, frame, timestamp, frameNumber } = data;

        // Log frame info but not the entire frame data
        console.log(`Relaying frame ${frameNumber} to viewer ${viewerId}, size: ${frame ? Math.round(frame.length / 1024) : 'unknown'} KB`);

        // Relay the webcam frame to viewers - with simplified data format
        io.to(viewerId).emit('webcam-frame', {
            frame: frame,
            computerId: socket.id,
            timestamp: timestamp,
            frameNumber: frameNumber
        });

        // Also relay with alternative event name for compatibility
        io.to(viewerId).emit('frame', {
            frame: frame,
            computerId: socket.id,
            timestamp: timestamp,
            frameNumber: frameNumber
        });

        // Update last seen timestamp
        if (connectedComputers.has(socket.id)) {
            const computerInfo = connectedComputers.get(socket.id);
            computerInfo.lastSeen = new Date();
            connectedComputers.set(socket.id, computerInfo);

            // Update registered computer's last seen as well
            if (registeredComputers.has(computerInfo.id)) {
                const registered = registeredComputers.get(computerInfo.id);
                registered.lastSeen = new Date();
                registeredComputers.set(computerInfo.id, registered);
            }
        }
    });

    socket.on('frame', (data) => {
        const { viewerId, frame, timestamp, frameNumber } = data;

        console.log(`Relaying frame (alt) ${frameNumber} to viewer ${viewerId}`);

        // Relay the frame to viewers with a simplified format
        io.to(viewerId).emit('frame', {
            frame: frame,
            computerId: socket.id
        });

        // Also send with the webcam-frame event name for compatibility
        io.to(viewerId).emit('webcam-frame', {
            frame: frame,
            computerId: socket.id
        });
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

            // Update registered computer's status if applicable
            if (registeredComputers.has(computerInfo.id)) {
                const registered = registeredComputers.get(computerInfo.id);
                registered.status = 'offline';
                registered.lastSeen = new Date();
                registeredComputers.set(computerInfo.id, registered);
            }

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

            // Update registered computer's status if applicable
            if (registeredComputers.has(computer.id)) {
                const registered = registeredComputers.get(computer.id);
                registered.status = 'offline';
                registered.lastSeen = new Date();
                registeredComputers.set(computer.id, registered);
            }

            io.emit('computers-updated');
        }
    }
}, 30000); // Check every 30 seconds

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});