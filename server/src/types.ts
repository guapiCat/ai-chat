// 前后端共享的 HTTP 契约。前端有一份对应的 frontend/src/types.ts，
// 两边改动需同步（刻意不为这几十行类型搭 monorepo）。

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  /** 用户中途停止了生成：此时的 content 只是已生成的部分内容 */
  stopped?: boolean;
}

/** 内存会话存储里的完整会话 */
export interface StoredSession {
  id: string;
  messages: Message[];
  createdAt: number;
}

/** GET /api/chat/sessions 列表项（不含 messages，正文按需单独拉） */
export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  msgCount: number;
}

/** SSE 帧载荷，序列化后形如 `data: {"type":"chunk","content":"..."}\n\n` */
export type ChatEvent =
  | { type: 'chunk'; content: string }
  | { type: 'done'; content: string }
  | { type: 'error'; content: string };

export interface SendRequestBody {
  sessionId?: string;
  message?: string;
}
