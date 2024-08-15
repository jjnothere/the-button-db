const express = require('express');
const cors = require('cors');
const path = require('path');
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

// Simple in-memory store for tracking requests per IP
const ipRequestCounts = new Map();
const REQUEST_LIMIT = 1000; // Max requests per minute
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
      console.log(`IP ${ip} is currently blocked until ${new Date(ipData.blockedUntil)}`);
      return res.status(429).json({ error: 'This site is for humans and not robots.....you clicked over 1,000 times a minute. You have been put in a 10-minute timeout.' });
    }

    // Calculate the time passed since last request
    const timePassed = currentTime - ipData.lastRequestTime;

    // Check if the interval between requests is consistent
    if (ipData.interval === timePassed) {
      ipData.sameIntervalCount += 1;
    } else {
      ipData.sameIntervalCount = 1;
      ipData.interval = timePassed;
    }

    // If 200 requests have been made with the same interval, block the IP
    if (ipData.sameIntervalCount >= 200) {
      ipRequestCounts.set(ip, {
        ...ipData,
        blockedUntil: currentTime + BLOCK_TIME
      });
      console.log(`IP ${ip} made 200 requests at the same interval and is blocked until ${new Date(currentTime + BLOCK_TIME)}`);
      return res.status(429).json({ error: 'Too many suspicious requests. You have been put in a 10-minute timeout.' });
    }

    // Reset count at the start of a new minute
    if (new Date(currentTime).getMinutes() !== new Date(ipData.lastRequestTime).getMinutes()) {
      ipData.count = 0; // Reset count
      ipData.sameIntervalCount = 0; // Reset the same interval count
      console.log(`IP ${ip} request count reset.`);
    }

    ipData.count += 1;
    ipData.lastRequestTime = currentTime;

    if (ipData.count > REQUEST_LIMIT) {
      // Block IP for a period of time
      ipRequestCounts.set(ip, {
        ...ipData,
        blockedUntil: currentTime + BLOCK_TIME
      });
      console.log(`IP ${ip} exceeded the request limit and is blocked until ${new Date(currentTime + BLOCK_TIME)}`);
      return res.status(429).json({ error: 'Too much ham. You are in a 10-minute timeout.' });
    } else {
      ipRequestCounts.set(ip, ipData);
      console.log(`IP ${ip} request count updated: ${ipData.count}`);
    }
  } else {
    // First request from this IP
    ipRequestCounts.set(ip, { count: 1, lastRequestTime: currentTime, sameIntervalCount: 0, interval: null });
    console.log(`First request from IP ${ip}.`);
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

// Apply IP tracking to the increment route
app.post('/api/increment', trackIpRequests, async (req, res) => {
  const referer = req.get('Referer');
  const origin = req.get('Origin');

  // Validate that the request is coming from your domain
  if (referer !== 'https://www.theclickcounter.com/' && origin !== 'https://www.theclickcounter.com' && origin !== 'http://localhost:5173/' && origin !== 'http://localhost:5173') {
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