const express = require('express');
const cors = require('cors');
const path = require('path');
const { MongoClient } = require('mongodb');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());

// Serve static files from the correct directory (root or public)
app.use(express.static(path.join(__dirname, 'public')));

// MongoDB connection URI from environment variable
const uri = process.env.MONGODB_URI;

let db, collection;
let count = 0;

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

// API routes
app.get('/api/count', (req, res) => {
  res.json({ count });
});

app.post('/api/increment', async (req, res) => {
  count += 1;
  console.log("🐒 ~ count:", count);

  try {
    await collection.updateOne(
      { _id: 'counter' },
      { $set: { count: count } },
      { upsert: true }
    );
    res.json({ count });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update counter in database' });
  }
});

// Fallback to serve index.html for any unknown routes (for Vue Router)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});