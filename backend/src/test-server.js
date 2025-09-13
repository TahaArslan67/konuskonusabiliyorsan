import express from 'express';
import mongoose from 'mongoose';

console.log('Test server starting...');

// Simple test endpoint
const app = express();
app.get('/', (req, res) => {
  res.send('Test server is running');
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Test server running on http://localhost:${PORT}`);
});
