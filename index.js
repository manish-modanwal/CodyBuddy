const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios'); 
const path = require('path');
const Room = require('./models/Room');
const Code = require('./models/Code');
const Snapshot= require('./models/Snapshot');
dotenv.config();


const app = express();
const server = http.createServer(app);

// Use middleware to parse JSON and URL-encoded bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors()); 

// --- 3. CONNECT TO MONGODB ---

mongoose.connect(process.env.MONGODB_URI)
    .then(() => {
        console.log('Connected to MongoDB');
    })
    .catch((err) => {
        console.error('Error connecting to MongoDB:', err);
    });


// --- 4. CONFIGURE SOCKET.IO SERVER ---
const io = new Server(server, {
    // Configure CORS for Socket.IO to allow connections from the frontend
    cors: {
        origin: 'http://localhost:5173', // Your frontend's URL (Vite default)
        methods: ['GET', 'POST'],
    },
});




// --- 5. HANDLE SOCKET.IO CONNECTIONS & EVENTS ---
io.on('connection', (socket) => {
    console.log(`A user connected with Id: ${socket.id}`);



    // --- A. Handle 'joinRoom' event when a user joins a room ---
    socket.on('joinRoom', async ({ roomId, userName }) => {
        socket.join(roomId);
        console.log(`User with ID: ${socket.id} joined room: ${roomId}`);

        // Notify other users in the room that a new user joined
        socket.to(roomId).emit('userJoined', {
            userId: socket.id,
            userName,
            message: `${userName} has joined the room`
        });
        
        try {
            // Find or create the room in the database
            let room = await Room.findOne({ roomId });
            if (!room) {
                // If the room doesn't exist, create it
                room = new Room({ roomId });
                await room.save();
                console.log(`Room created in DB: ${roomId}`);
            }

            // Fetch the latest code snapshot for the room
            const latestCode = await Code.findOne({ roomId }).sort({ timestamp: -1 });

            // If there's existing code, send it to the new user
            if (latestCode) {
                socket.emit('code-change', { code: latestCode.content });
                socket.emit('language-change', { language: latestCode.language });
            }
        } catch (error) {
            console.error('Error joining room:', error);
        }
    });



    // --- B. Handle 'code-change' event for live sync ---
    socket.on('code-change', ({ roomId, code, language }) => {
        // Broadcast the code change to all other users in the same room
        socket.to(roomId).emit('code-change', { code });

        // Save the code snapshot to the database
        // NOTE: This can be optimized (e.g., save every few seconds)
        // For now, we update on every change for demonstration.
        Code.findOneAndUpdate(
            { roomId }, 
            { content: code, language: language || 'javascript' }, 
            { upsert: true, new: true, sort: { timestamp: -1 } }
        ).catch(err => console.error('Error saving code snapshot:', err));
    });




    // --- C. Handle 'language-change' event ---
    socket.on('language-change', ({ roomId, language }) => {
        // Broadcast the language change to all other users
        socket.to(roomId).emit('language-change', { language });
    });





    // --- D. Handle 'run-code' event (Compiler API Integration with Judge0) ---
    socket.on('run-code', async ({ code, languageId }) => {
        const JUDGE0_URL = process.env.JUDGE0_URL || 'https://judge0-ce.p.rapidapi.com/submissions';
        const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
        const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'judge0-ce.p.rapidapi.com';
        
        if (!RAPIDAPI_KEY) {
            console.error('RAPIDAPI_KEY is not set in .env file.');
            socket.emit('code-output', { output: 'Error: Compiler API key is missing.' });
            return;
        }

        const options = {
            method: 'POST',
            url: JUDGE0_URL,
            params: {
                base64_encoded: 'false',
                fields: '*' // Get all fields including stdout, stderr, compile_output
            },
            headers: {
                'content-type': 'application/json',
                'X-RapidAPI-Key': RAPIDAPI_KEY,
                'X-RapidAPI-Host': RAPIDAPI_HOST,
            },
            data: {
                language_id: languageId,
                source_code: code,
                stdin: '' // You can add user input here if needed
            },
        };

        try {
            const response = await axios.request(options);
            const token = response.data.token;
            
            // Poll for the submission status until it's processed
            let result;
            do {
                const resultResponse = await axios.get(`${JUDGE0_URL}/${token}`, { headers: options.headers });
                result = resultResponse.data;
                if (result.status.id < 3) { // 1=In Queue, 2=Processing
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            } while (result.status.id < 3); // 3=Accepted

            // Determine the output
            let output = result.stdout || result.stderr || result.compile_output || 'No output.';
            if (output === null) output = 'No output.'; // Handle null output gracefully

            // Broadcast the output back to the user who ran the code
            socket.emit('code-output', { output, status: result.status.description });
        } catch (error) {
            console.error('Error running code with Judge0:', error.response ? error.response.data : error.message);
            socket.emit('code-output', { output: 'Error running code. Please check your code or server logs.' });
        }
    });
    

       // --- E. Handle 'save-snapshot' event ---
    socket.on('save-snapshot', async ({ roomId, code, userName }) => {
        try {
            // Create a new snapshot document in the database
            const newSnapshot = new Snapshot({ roomId, content: code, userName });
            await newSnapshot.save();
            
            console.log(`Snapshot saved for room ${roomId} by ${userName}`);

            // You can emit a success message back to the sender
            socket.emit('snapshot-saved', { message: 'Snapshot saved successfully!' });
        } catch (error) {
            console.error('Error saving snapshot:', error);
            socket.emit('snapshot-error', { message: 'Failed to save snapshot.' });
        }
    });

    // --- F. Handle 'get-snapshots' event ---
    socket.on('get-snapshots', async ({ roomId }) => {
        try {
            // Find all snapshots for the given room, sorted by most recent first
            const snapshots = await Snapshot.find({ roomId }).sort({ timestamp: -1 });

            // Send the list of snapshots back to the user who requested it
            socket.emit('snapshots-list', { snapshots });
        } catch (error) {
            console.error('Error fetching snapshots:', error);
            socket.emit('snapshots-error', { message: 'Failed to fetch snapshots.' });
        }
    });

    // --- G. Handle 'revert-to-snapshot' event ---
    socket.on('revert-to-snapshot', async ({ roomId, snapshotId }) => {
        try {
            // Find the specific snapshot by its ID
            const snapshot = await Snapshot.findById(snapshotId);

            if (snapshot) {
                // Broadcast the code from the snapshot to everyone in the room
                io.to(roomId).emit('code-change', { code: snapshot.content });
                console.log(`Room ${roomId} reverted to snapshot: ${snapshotId}`);

                // You can also save this reverted code as the new latest version in your Code model
                await Code.findOneAndUpdate(
                    { roomId }, 
                    { content: snapshot.content }, 
                    { upsert: true }
                );
            }
        } catch (error) {
            console.error('Error reverting to snapshot:', error);
        }
    });




    // --- E. Handle 'disconnect' event when a user leaves ---
    socket.on('disconnecting', () => {
        // Get all the rooms the socket was in (excluding its own ID)
        const rooms = [...socket.rooms].filter(room => room !== socket.id);
        rooms.forEach(roomId => {
            // Notify other users in the room that a user has left
            socket.to(roomId).emit('userLeft', { userId: socket.id, message: `User ${socket.id} has left the room.` });
        });
    });
    
    // Final disconnect event
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
    });
});

// --- 6. START THE SERVER ---
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// --- 7. EXPORT MODULES (Optional but good for testing) ---
module.exports = server;
module.exports.io = io;
module.exports.app = app;