const { Router } = require('express');
const aiService = require('../services/ai');

const router = Router();

// ====== 内存会话存储 ======
const sessions = new Map();
let idCounter = 0;

function createSession(id) {
  const sessionId = id || String(++idCounter);
  const session = { id: sessionId, messages: [], createdAt: Date.now() };
  sessions.set(sessionId, session);
  return session;
}

// ====== 发送消息（SSE 流式响应） ======
router.post('/send', async (req, res) => {
  const { sessionId, message } = req.body;

  if (!sessionId || !message?.trim()) {
    return res.status(400).json({ error: 'sessionId and message are required' });
  }

  // 获取或创建会话。必须沿用客户端传来的 sessionId，
  // 否则（例如服务重启后内存会话丢失）每发一条消息都会新建会话，多轮上下文全丢
  let session = sessions.get(sessionId);
  if (!session) {
    session = createSession(sessionId);
  }
  session.messages.push({ role: 'user', content: message.trim() });

  // SSE 响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let fullContent = '';

  try {
    // 控制上下文窗口：保留最近 20 条消息
    const contextMessages = session.messages.slice(-20);

    await aiService.chatStream(contextMessages, (chunk) => {
      fullContent += chunk;
      // 发送内容块
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`);
    });

    // 保存助手回复
    session.messages.push({ role: 'assistant', content: fullContent });

    // 发送完成信号
    res.write(`data: ${JSON.stringify({ type: 'done', content: fullContent })}\n\n`);
  } catch (error) {
    console.error('[Chat Error]', error.message);
    res.write(`data: ${JSON.stringify({ type: 'error', content: error.message })}\n\n`);
  } finally {
    res.end();
  }
});

// ====== 获取会话列表 ======
router.get('/sessions', (req, res) => {
  const list = Array.from(sessions.values())
    .map(s => {
      const firstMsg = s.messages.find(m => m.role === 'user');
      return {
        id: s.id,
        title: firstMsg?.content?.slice(0, 40) || '新对话',
        createdAt: s.createdAt,
        msgCount: Math.ceil(s.messages.length / 2),
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json(list);
});

// ====== 获取某条会话的消息 ======
router.get('/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ id: session.id, messages: session.messages });
});

// ====== 创建新会话 ======
router.post('/sessions', (req, res) => {
  const session = createSession();
  res.json({ id: session.id });
});

// ====== 删除会话 ======
router.delete('/sessions/:id', (req, res) => {
  sessions.delete(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
