// 必须是裸副作用导入且置于第一行。import 会被提升到文件顶部，
// 若改成 `import dotenv from 'dotenv'` + 函数体内 config()，
// config() 将晚于本模块依赖链（services/ai）的求值，代理与 PORT 静默失效。
import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import chatRoutes from './routes/chat';
import aiService from './services/ai';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use('/api/chat', chatRoutes);

app.get('/api/health', (_req, res) => {
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
