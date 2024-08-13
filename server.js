require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
const port = 3000;

// Use CORS to allow requests from your front-end
app.use(cors());

// MongoDB connection URI from environment variable
const uri = process.env.MONGODB_URI;

// MongoDB client and database setup
let db, collection;
let count = 0;

MongoClient.connect(uri)
  .then(async client => {
    console.log('Connected to Database');
    db = client.db('the-button');
    collection = db.collection('counter');

    // Load the current counter value from the database
    const counterDoc = await collection.findOne({ _id: 'counter' });
    if (counterDoc && counterDoc.count !== undefined) {
      count = counterDoc.count;
    } else {
      // Initialize the counter in the database if it doesn't exist
      await collection.insertOne({ _id: 'counter', count: 0 });
    }
    console.log(`Initial counter value loaded: ${count}`);
  })
  .catch(error => console.error(error));

// Endpoint to get the current count
app.get('/count', (req, res) => {
  res.json({ count });
});

// Endpoint to increment the count
app.post('/increment', async (req, res) => {
  count += 1;
  console.log("🐒 ~ count:", count);
  
  try {
    // Update the counter document in the database with the new count
    const result = await collection.updateOne(
      { _id: 'counter' }, // Use a fixed ID so we always update the same document
      { $set: { count: count } }, // Set the new counter value
      { upsert: true } // Insert the document if it doesn't exist
    );
    res.json({ count });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update counter in database' });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});