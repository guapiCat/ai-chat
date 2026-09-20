const express = require('express');
const cors = require('cors');
require('dotenv').config();

const chatRoutes = require('./routes/chat');
const aiService = require('./services/ai');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use('/api/chat', chatRoutes);

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    llm: {
      configured: aiService.isConfigured,
      baseUrl: aiService.baseUrl,
      model: aiService.model,
    },
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[AI Chat] Server running on http://localhost:${PORT}`);
  console.log(`[AI Chat] API Base: ${aiService.baseUrl}`);
  console.log(`[AI Chat] Model: ${aiService.model}`);
  if (aiService.isConfigured) {
    console.log('[AI Chat] OPENAI_API_KEY: 已配置 ✅');
  } else {
    console.warn('[AI Chat] OPENAI_API_KEY: 未配置 ⚠️  请在 server/.env 中填入真实 Key，否则对话会直接报错');
  }
});
