// Client software to run on computers that will be monitored
const io = require('socket.io-client');
const nodeWebcam = require('node-webcam');
const os = require('os');
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const https = require('https');

// Configuration
const SERVER_URL = 'https://remote-monitor.onrender.com'; // Replace with your server address
const DEFAULT_NAME = os.hostname();
const FRAME_RATE = 5; // Reduced frame rate for lighter bandwidth usage
const FRAME_INTERVAL = Math.floor(1000 / FRAME_RATE);
const IMAGE_QUALITY = 30; // Reduced quality for lighter bandwidth usage
const SOCKET_OPTIONS = {
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000,
    transports: ['websocket', 'polling'] // Try websocket first, fallback to polling
};

// Create a temp directory in a location we control
const TEMP_DIR = path.join(os.tmpdir(), 'webcam-monitor');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// First, check server connectivity
console.log(`Testing connection to server: ${SERVER_URL}`);
https.get(SERVER_URL, (res) => {
    console.log(`Server responded with status code: ${res.statusCode}`);
    startClient();
}).on('error', (err) => {
    console.error(`Server connection test failed: ${err.message}`);
    console.log("Continuing anyway...");
    startClient();
});

function startClient() {
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
        console.log(`Frame rate: ${FRAME_RATE} FPS, Quality: ${IMAGE_QUALITY}%`);

        // Connect with more robust socket options
        const socket = io(SERVER_URL, SOCKET_OPTIONS);

        // Set up webcam with lower resolution and faster settings
        const webcamOptions = {
            width: 320,        // Low resolution
            height: 240,       // Low resolution
            quality: IMAGE_QUALITY,
            output: 'jpeg',
            device: false,     // Use default webcam
            callbackReturn: 'base64',
            saveShots: true,
            location: TEMP_DIR,
            verbose: true      // Set to true for more debugging
        };

        const Webcam = nodeWebcam.create(webcamOptions);

        // Track active streams
        const activeStreams = new Set();

        // Test webcam before starting
        console.log("Testing webcam...");
        Webcam.capture('test', (err, data) => {
            if (err) {
                console.error('Webcam test failed:', err);
                console.log('Please make sure your webcam is connected and not in use by another application.');
            } else {
                console.log('Webcam test successful!');
                // Log the size of the test image to help diagnose bandwidth issues
                const base64Data = data.replace(/^data:image\/jpeg;base64,/, '');
                console.log(`Test image size: ${Math.round(base64Data.length / 1024)} KB`);
            }
        });

        // Register computer when connected
        socket.on('connect', () => {
            console.log('Connected to server with ID:', socket.id);
            console.log('Transport type:', socket.io.engine.transport.name);

            // Send registration with additional info
            socket.emit('register-computer', {
                name: computerName,
                socketId: socket.id,
                capabilities: {
                    webcam: true,
                    audio: false
                },
                systemInfo: {
                    platform: os.platform(),
                    arch: os.arch(),
                    version: os.version(),
                    hostname: os.hostname()
                }
            });

            console.log('Computer registered');
            console.log('Waiting for stream requests...');
        });

        // Debug all socket events
        socket.onAny((eventName, ...args) => {
            console.log(`Received event: ${eventName}`, args);
        });

        // Debug all emits
        const originalEmit = socket.emit;
        socket.emit = function(eventName, ...args) {
            console.log(`Emitting event: ${eventName}`, args[0] ?
                (args[0].frame ? `[Frame data: ${Math.round((args[0].frame || '').length / 1024)} KB]` : args[0])
                : '');
            return originalEmit.apply(this, [eventName, ...args]);
        };

        // Add test response handler
        socket.on('test-connection', (data) => {
            console.log('Received test connection:', data);
            // Send back acknowledgment
            socket.emit('test-response', {
                received: true,
                time: Date.now(),
                computerName
            });
        });

        // Handle stream requests
        socket.on('start-stream', (data) => {
            const { viewerId } = data;

            console.log(`Starting stream for viewer: ${viewerId}`);
            activeStreams.add(viewerId);

            // Acknowledge the request to the server
            socket.emit('stream-ack', { viewerId, status: 'starting' });

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
        socket.on('disconnect', (reason) => {
            console.log('Disconnected from server. Reason:', reason);

            // Stop streaming but don't clear active streams in case we reconnect
            stopStreaming();

            console.log('Will attempt to reconnect automatically...');
        });

        // Stream management
        let streamingInterval = null;
        let frameCount = 0;
        let lastFrameTime = 0;
        let framesSent = 0;
        let frameErrors = 0;

        function startStreaming() {
            if (streamingInterval) return;

            console.log('Starting webcam capture');
            frameCount = 0;
            framesSent = 0;
            frameErrors = 0;
            lastFrameTime = Date.now();

            streamingInterval = setInterval(() => {
                if (activeStreams.size === 0) {
                    stopStreaming();
                    return;
                }

                // Capture frame
                try {
                    console.log('Capturing frame...');
                    Webcam.capture('frame', (err, data) => {
                        if (err) {
                            console.error('Webcam capture error:', err);
                            frameErrors++;
                            return;
                        }

                        // Remove data:image/jpeg;base64, prefix
                        const base64Data = data.replace(/^data:image\/jpeg;base64,/, '');

                        console.log(`Frame captured: ${Math.round(base64Data.length / 1024)} KB`);

                        // Calculate FPS for logging
                        frameCount++;
                        framesSent++;
                        const now = Date.now();
                        if (now - lastFrameTime >= 5000) {
                            const fps = frameCount / ((now - lastFrameTime) / 1000);
                            console.log(`Streaming at ${fps.toFixed(1)} FPS, sent ${framesSent} frames, errors: ${frameErrors}`);
                            frameCount = 0;
                            lastFrameTime = now;
                        }

                        // Send one simplified event with just the frame data for each viewer
                        for (const viewerId of activeStreams) {
                            // Simplified payload - just the essential data
                            socket.emit('webcam-frame', {
                                viewerId,
                                frame: base64Data,
                                timestamp: Date.now(),
                                frameNumber: framesSent
                            });
                        }

                        // Try to clean up the temp file (asynchronously)
                        fs.unlink(path.join(TEMP_DIR, 'frame.jpg'), (err) => {
                            // Ignore errors during cleanup
                        });
                    });
                } catch (e) {
                    console.error('Error during frame capture:', e);
                    frameErrors++;
                }
            }, FRAME_INTERVAL);
        }

        function stopStreaming() {
            if (streamingInterval) {
                console.log('Stopping webcam capture');
                console.log(`Stats: Sent ${framesSent} frames, had ${frameErrors} errors`);
                clearInterval(streamingInterval);
                streamingInterval = null;
            }
        }

        // Send periodic heartbeats to keep connection alive
        const heartbeatInterval = setInterval(() => {
            if (socket.connected) {
                socket.emit('heartbeat', {
                    computerName,
                    timestamp: Date.now(),
                    activeStreams: Array.from(activeStreams)
                });
            }
        }, 15000);

        // Handle process termination
        process.on('SIGINT', () => {
            console.log('\nShutting down client...');
            stopStreaming();
            clearInterval(heartbeatInterval);
            socket.disconnect();
            rl.close();
            process.exit(0);
        });
    });
}