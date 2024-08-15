const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto'); // For generating tokens
const { MongoClient } = require('mongodb');
const { Server } = require('ws');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, '../public')));

const uri = process.env.MONGODB_URI;
console.log('MongoDB URI:', uri);
let db, collection;
let count = 0;

// Token management
let currentToken = generateToken();
let tokenExpiration = Date.now() + 5 * 60 * 1000; // Token valid for 5 minutes

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

function rotateToken() {
  currentToken = generateToken();
  tokenExpiration = Date.now() + 5 * 60 * 1000;
}

setInterval(rotateToken, 5 * 60 * 1000); // Rotate the token every 5 minutes

// Middleware to check the token
function validateToken(req, res, next) {
  const token = req.headers['x-access-token'];
  if (!token || token !== currentToken) {
    return res.status(403).json({ error: 'Invalid or missing token' });
  }
  next();
}

// Simple in-memory store for tracking requests per IP
const ipRequestCounts = new Map();
const REQUEST_LIMIT = 3000; // Max requests per minute
const BLOCK_TIME = 10 * 60 * 1000; // Block for 10 minutes

function getIp(req) {
  // If behind a proxy or load balancer, use X-Forwarded-For header
  return req.headers['x-forwarded-for'] || req.ip;
}

function trackIpRequests(req, res, next) {
  const ip = getIp(req);
  const currentTime = Date.now();

  if (ipRequestCounts.has(ip)) {
    const ipData = ipRequestCounts.get(ip);
    
    // If IP is currently blocked
    if (ipData.blockedUntil && ipData.blockedUntil > currentTime) {
      return res.status(429).json({ error: 'You have been put in a 10-minute timeout.' });
    }

    // Calculate the time passed since last request
    const timePassed = currentTime - ipData.lastRequestTime;

    // Reset count if more than a minute has passed
    if (timePassed > 60 * 1000) {
      ipRequestCounts.set(ip, { count: 1, lastRequestTime: currentTime });
    } else {
      ipData.count += 1;
      ipData.lastRequestTime = currentTime;

      if (ipData.count > REQUEST_LIMIT) {
        // Block IP for a period of time
        ipRequestCounts.set(ip, {
          ...ipData,
          blockedUntil: currentTime + BLOCK_TIME
        });
        return res.status(429).json({ error: 'Too much ham. You are in a 10-minute timeout.' });
      } else {
        ipRequestCounts.set(ip, ipData);
      }
    }
  } else {
    // First request from this IP
    ipRequestCounts.set(ip, { count: 1, lastRequestTime: currentTime });
  }

  next();
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

// API to get the current token (for initial load)
app.get('/api/token', (req, res) => {
  res.json({ token: currentToken });
});

// Apply both IP tracking and token validation to the increment route
app.post('/api/increment', validateToken, trackIpRequests, async (req, res) => {
  const referer = req.get('Referer');
  const origin = req.get('Origin');

  // Validate that the request is coming from your domain
  if (referer !== 'https://www.theclickcounter.com/' && origin !== 'https://www.theclickcounter.com' && origin !== 'http://localhost:3000') {
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