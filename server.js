require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const articleRoutes = require('./routes/articles');
const adminRoutes = require('./routes/admin');
const { startIngestSchedule } = require('./cron/ingest');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/articles', articleRoutes);
app.use('/api/admin', adminRoutes);

app.get('/', (req, res) => {
  res.send('News app backend is running.');
});

const PORT = process.env.PORT || 5000;

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    startIngestSchedule(); // begins hourly AI ingest pipeline
  });
});
