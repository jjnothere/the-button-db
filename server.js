const express = require('express');
const cors = require('cors');
const path = require('path');
const { MongoClient } = require('mongodb');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());

// Serve static files from the dist directory (created by `npm run build`)
app.use(express.static(path.join(__dirname, 'dist')));

// MongoDB connection URI from environment variable
const uri = process.env.MONGODB_URI;

let db, collection;
let count = 0;

// Connect to MongoDB and load the initial counter value
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

// Endpoint to get the current count
app.get('/api/count', (req, res) => {
  res.json({ count });
});

// Endpoint to increment the count
app.post('/api/increment', async (req, res) => {
  count += 1;
  console.log("🐒 ~ count:", count);
  
  try {
    const result = await collection.updateOne(
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

// Fallback to serve the index.html for any unknown routes (for Vue Router)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});