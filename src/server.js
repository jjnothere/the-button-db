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

// Simple in-memory store for tracking requests per IP
const ipRequestCounts = new Map();
const REQUEST_LIMIT = 500; // Max requests per minute
const BLOCK_TIME = 10 * 60 * 1000; // Block for 10 minutes
const CONSISTENT_INTERVAL_CHECK = 50; // Number of clicks to check for consistent intervals

// Simple in-memory rate limiter for burst control
const rateLimiters = new Map();
const RATE_LIMIT = 20; // Max requests per second

function rateLimiter(req, res, next) {
  const ip = req.ip;
  const currentTime = Date.now();

  if (!rateLimiters.has(ip)) {
    rateLimiters.set(ip, { count: 1, lastRequest: currentTime, clickTimes: [currentTime] });
    next();
  } else {
    const { count, lastRequest, clickTimes } = rateLimiters.get(ip);
    
    // Check if more than 1 second has passed
    if (currentTime - lastRequest >= 1000) {
      // Reset count and clickTimes for a new second
      rateLimiters.set(ip, { count: 1, lastRequest: currentTime, clickTimes: [currentTime] });
      next();
    } else {
      if (count >= RATE_LIMIT) {
        console.log("🐒 ~ RATE_LIMIT:", RATE_LIMIT)
        console.log("🐒 ~ count:", count)
        return res.status(429).json({ error: 'Wow you are either super human or a robot....please slow down' });
      } else {
        // Update click times and check for consistency
        clickTimes.push(currentTime);
        if (clickTimes.length > CONSISTENT_INTERVAL_CHECK) {
          clickTimes.shift(); // Keep only the last N timestamps
          if (isConsistent(clickTimes)) {
            return res.status(429).json({ error: 'This site is for humans only...sorry robots.' });
          }
        }
        rateLimiters.set(ip, { count: count + 1, lastRequest: currentTime, clickTimes });
        next();
      }
    }
  }
}

function isConsistent(clickTimes) {
  const intervals = clickTimes.slice(1).map((time, index) => time - clickTimes[index]);
  const firstInterval = intervals[0];
  return intervals.every(interval => Math.abs(interval - firstInterval) < 20); // Increased tolerance to 20ms
}

function trackIpRequests(req, res, next) {
  const ip = req.ip;
  const currentTime = Date.now();

  if (ipRequestCounts.has(ip)) {
    const ipData = ipRequestCounts.get(ip);
    
    // If IP is currently blocked
    if (ipData.blockedUntil && ipData.blockedUntil > currentTime) {
      return res.status(429).json({ error: 'WOW that was way too many cicks for a normal human. You are in a 10min time out. :(' });
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
        return res.status(429).json({ error: 'Too many requests. Try again later. You are in a 10min time out. :(' });
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

// Apply both IP tracking and rate limiting to the increment route
app.post('/api/increment', trackIpRequests, rateLimiter, async (req, res) => {
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