// Client software to run on computers that will be monitored
const io = require('socket.io-client');
const nodeWebcam = require('node-webcam');
const os = require('os');
const readline = require('readline');

// Configuration
const SERVER_URL = 'http://your-server-ip:3000'; // Replace with your server address
const DEFAULT_NAME = os.hostname();
const FRAME_RATE = 15; // Frames per second
const FRAME_INTERVAL = Math.floor(1000 / FRAME_RATE);
const IMAGE_QUALITY = 50; // JPEG quality (0-100)

// Command line interface
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Get computer name
rl.question(`Enter computer name (default: ${DEFAULT_NAME}): `, (name) => {
    const computerName = name || DEFAULT_NAME;

    console.log(`Starting webcam client for: ${computerName}`);
    console.log(`Connecting to server: ${SERVER_URL}`);

    const socket = io(SERVER_URL);

    // Set up webcam
    const webcamOptions = {
        width: 640,
        height: 480,
        quality: IMAGE_QUALITY,
        output: 'jpeg',
        device: false, // Use default webcam
        callbackReturn: 'base64'
    };

    const Webcam = nodeWebcam.create(webcamOptions);

    // Track active streams
    const activeStreams = new Set();

    // Register computer when connected
    socket.on('connect', () => {
        console.log('Connected to server');

        socket.emit('register-computer', {
            name: computerName,
            capabilities: {
                webcam: true,
                audio: false // Not implemented in this version
            }
        });

        console.log('Computer registered');
        console.log('Waiting for stream requests...');
    });

    // Handle stream requests
    socket.on('start-stream', (data) => {
        const { viewerId } = data;

        console.log(`Starting stream for viewer: ${viewerId}`);
        activeStreams.add(viewerId);

        // If this is the first active stream, start capturing
        if (activeStreams.size === 1) {
            startStreaming();
        }
    });

    // Handle stop stream requests
    socket.on('stop-stream', (data) => {
        const { viewerId } = data;

        console.log(`Stopping stream for viewer: ${viewerId}`);
        activeStreams.delete(viewerId);

        // If no more active streams, stop capturing
        if (activeStreams.size === 0) {
            stopStreaming();
        }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log('Disconnected from server');
        stopStreaming();
        activeStreams.clear();

        // Try to reconnect
        setTimeout(() => {
            console.log('Attempting to reconnect...');
            socket.connect();
        }, 5000);
    });

    // Stream management
    let streamingInterval = null;

    function startStreaming() {
        if (streamingInterval) return;

        console.log('Starting webcam capture');
        streamingInterval = setInterval(() => {
            if (activeStreams.size === 0) {
                stopStreaming();
                return;
            }

            // Capture frame
            Webcam.capture('temp', (err, data) => {
                if (err) {
                    console.error('Webcam capture error:', err);
                    return;
                }

                // Remove data:image/jpeg;base64, prefix
                const base64Data = data.replace(/^data:image\/jpeg;base64,/, '');

                // Send frame to each viewer
                for (const viewerId of activeStreams) {
                    socket.emit('webcam-frame', {
                        viewerId,
                        frame: base64Data
                    });
                }
            });
        }, FRAME_INTERVAL);
    }

    function stopStreaming() {
        if (streamingInterval) {
            console.log('Stopping webcam capture');
            clearInterval(streamingInterval);
            streamingInterval = null;
        }
    }

    // Handle process termination
    process.on('SIGINT', () => {
        console.log('\nShutting down client...');
        stopStreaming();
        socket.disconnect();
        rl.close();
        process.exit(0);
    });
});