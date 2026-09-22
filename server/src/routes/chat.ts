import { Router } from 'express';
import type { Request } from 'express';
import aiService from '../services/ai';
import type {
  ChatEvent,
  SendRequestBody,
  SessionSummary,
  StoredSession,
} from '../types';

const router = Router();

// ====== 内存会话存储 ======
const sessions = new Map<string, StoredSession>();
let idCounter = 0;

function createSession(id?: string): StoredSession {
  const sessionId = id || String(++idCounter);
  const session: StoredSession = { id: sessionId, messages: [], createdAt: Date.now() };
  sessions.set(sessionId, session);
  return session;
}

// ====== 发送消息（SSE 流式响应） ======
router.post(
  '/send',
  async (req: Request<Record<string, string>, unknown, SendRequestBody>, res) => {
    const { sessionId, message } = req.body;

    if (!sessionId || !message?.trim()) {
      res.status(400).json({ error: 'sessionId and message are required' });
      return;
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
        const event: ChatEvent = { type: 'chunk', content: chunk };
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      });

      // 保存助手回复
      session.messages.push({ role: 'assistant', content: fullContent });

      const doneEvent: ChatEvent = { type: 'done', content: fullContent };
      res.write(`data: ${JSON.stringify(doneEvent)}\n\n`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error('[Chat Error]', reason);
      const errorEvent: ChatEvent = { type: 'error', content: reason };
      res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
    } finally {
      res.end();
    }
  }
);

// ====== 获取会话列表 ======
router.get('/sessions', (_req, res) => {
  const list: SessionSummary[] = Array.from(sessions.values())
    .map((s) => {
      const firstMsg = s.messages.find((m) => m.role === 'user');
      return {
        id: s.id,
        title: firstMsg?.content.slice(0, 40) || '新对话',
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
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ id: session.id, messages: session.messages });
});

// ====== 创建新会话 ======
router.post('/sessions', (_req, res) => {
  const session = createSession();
  res.json({ id: session.id });
});

// ====== 删除会话 ======
router.delete('/sessions/:id', (req, res) => {
  sessions.delete(req.params.id);
  res.json({ ok: true });
});

export default router;
