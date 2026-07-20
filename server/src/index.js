const express = require('express');
const cors = require('cors');
require('dotenv').config();

const chatRoutes = require('./routes/chat');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use('/api/chat', chatRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[AI Chat] Server running on http://localhost:${PORT}`);
  console.log(`[AI Chat] API Base: ${process.env.AI_BASE_URL || 'https://api.openai.com/v1'}`);
  console.log(`[AI Chat] Model: ${process.env.AI_MODEL || 'gpt-3.5-turbo'}`);
});
