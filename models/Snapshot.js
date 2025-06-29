const mongoose = require('mongoose');

// Define the schema for a code snapshot
const snapshotSchema = new mongoose.Schema({
    roomId: {
        type: String,
        required: true,
    },
    content: {
        type: String,
        required: true,
    },
    userName: {
        type: String,
        required: true,
    },
    timestamp: {
        type: Date,
        default: Date.now,
    },
});

// Create the Mongoose model
const Snapshot = mongoose.model('Snapshot', snapshotSchema);

// Export the model for use in other files
module.exports = Snapshot;