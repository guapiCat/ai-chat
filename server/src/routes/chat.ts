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

    // 客户端断开（点了「停止」，或网络掉线）时要立刻中止上游请求。
    // 否则人都走了，OpenAI 还会把整条回复生成完，token 白烧。
    // 正常结束时 close 同样会触发，但那时 writableEnded 已为 true，借此区分两者。
    const upstream = new AbortController();
    let clientGone = false;
    res.on('close', () => {
      if (res.writableEnded) return;
      clientGone = true;
      upstream.abort();
    });

    let fullContent = '';

    // 连接已断时不能再往 res 写
    const send = (event: ChatEvent): void => {
      if (clientGone) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      // 控制上下文窗口：保留最近 20 条消息
      const contextMessages = session.messages.slice(-20);

      await aiService.chatStream(
        contextMessages,
        (chunk) => {
          fullContent += chunk;
          send({ type: 'chunk', content: chunk });
        },
        upstream.signal
      );

      // 保存助手回复
      session.messages.push({ role: 'assistant', content: fullContent });
      send({ type: 'done', content: fullContent });
    } catch (error) {
      if (clientGone) {
        // 用户主动停止：上游已被中止，拿不到完整回复，但也不能假装这轮没发生过。
        // 已生成的部分要落库并打标记，否则刷新或切会话后这段内容会凭空消失，
        // 而模型下次也会以为上一轮是完整的。
        if (fullContent) {
          session.messages.push({ role: 'assistant', content: fullContent, stopped: true });
        }
      } else {
        const reason = error instanceof Error ? error.message : String(error);
        console.error('[Chat Error]', reason);
        send({ type: 'error', content: reason });
      }
    } finally {
      if (!clientGone) res.end();
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
