// models/Code.js
const mongoose = require('mongoose');

const codeSchema = new mongoose.Schema({
    roomId: {
        type: String,
        required: true
    },
    content: {
        type: String,
        default: '' // The code content
    },
    language: {
        type: String,
        default: 'javascript' // Default language
    },
    timestamp: {
        type: Date,
        default: Date.now
    },
});

module.exports = mongoose.model('Code', codeSchema);