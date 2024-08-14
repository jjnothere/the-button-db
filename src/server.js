const express = require('express');
const cors = require('cors');
const path = require('path');
const { MongoClient } = require('mongodb');
const { Server } = require('ws'); // Import WebSocket server
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());

app.use(express.static(path.join(__dirname, '../public')));

const uri = process.env.MONGODB_URI;
console.log('MongoDB URI:', uri);
let db, collection;
let count = 0;

// Simple in-memory rate limiter
const rateLimiters = new Map();

function rateLimiter(req, res, next) {
  const ip = req.ip;
  const currentTime = Date.now();

  if (!rateLimiters.has(ip)) {
    rateLimiters.set(ip, { count: 1, lastRequest: currentTime });
    next();
  } else {
    const { count, lastRequest } = rateLimiters.get(ip);

    if (currentTime - lastRequest < 1000) { // Less than 1 second has passed
      if (count >= 5) {
        return res.status(429).json({ error: 'Too many requests - please slow down' });
      } else {
        rateLimiters.set(ip, { count: count + 1, lastRequest: currentTime });
        next();
      }
    } else {
      // More than 1 second has passed
      rateLimiters.set(ip, { count: 1, lastRequest: currentTime });
      next();
    }
  }
}

MongoClient.connect(uri)
  .then(async client => {
    console.log('Connected to Database');
    db = client.db('the-button');
    collection = db.collection('counter');

    const counterDoc = await collection.findOne({ _id: 'counter' });
    if (counterDoc && counterDoc.count !== undefined) {
      count = counterDoc.count;
    } else {
      await collection.insertOne({ _id: 'counter', count: 0 });
    }
    console.log(`Initial counter value loaded: ${count}`);
  })
  .catch(error => console.error(error));

// WebSocket setup
const server = app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

const wss = new Server({ server });

wss.on('connection', ws => {
  ws.send(JSON.stringify({ count }));

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

// API routes
app.get('/api/count', (req, res) => {
  res.json({ count });
});

app.post('/api/increment', rateLimiter, async (req, res) => {
  const referer = req.get('Referer');
  const origin = req.get('Origin');

  // Validate that the request is coming from your domain
  if (referer !== 'https://www.theclickcounter.com/' && origin !== 'https://www.theclickcounter.com') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Proceed with incrementing the counter if validation passes
  count += 1;

  try {
    await collection.updateOne(
      { _id: 'counter' },
      { $set: { count: count } },
      { upsert: true }
    );

    // Broadcast the new count to all connected WebSocket clients
    wss.clients.forEach(client => {
      if (client.readyState === client.OPEN) {
        client.send(JSON.stringify({ count }));
      }
    });

    res.json({ count });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update counter in database' });
  }
});

// Fallback to serve index.html for any unknown routes (for Vue Router)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'index.html'));
});