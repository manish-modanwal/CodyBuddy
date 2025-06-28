// models/Room.js
const mongoose = require('mongoose');

const roomSchema = new mongoose.Schema({
    roomId: {
        type: String,
        required: true,
        unique: true, // Ensures each room ID is unique
        trim: true
    },
    // Optional: Add more fields like creation date
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('Room', roomSchema);