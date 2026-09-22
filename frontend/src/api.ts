import type { ChatEvent, ChatStreamHandlers, Message, Session } from './types';

const API_BASE = '/api/chat';

// 说明：下面 res.json() 的断言是 HTTP 边界断言，不做运行时校验。
// 类型是声明不是保证——后端若改了契约，这里不会报错。

/** 获取会话列表 */
export async function fetchSessions(): Promise<Session[]> {
  const res = await fetch(`${API_BASE}/sessions`);
  return (await res.json()) as Session[];
}

/** 创建新会话 */
export async function createSession(): Promise<{ id: string }> {
  const res = await fetch(`${API_BASE}/sessions`, { method: 'POST' });
  return (await res.json()) as { id: string };
}

/** 获取会话消息 */
export async function fetchSession(id: string): Promise<{ id: string; messages: Message[] }> {
  const res = await fetch(`${API_BASE}/sessions/${id}`);
  if (!res.ok) throw new Error('Session not found');
  return (await res.json()) as { id: string; messages: Message[] };
}

/** 删除会话 */
export async function deleteSession(id: string): Promise<void> {
  await fetch(`${API_BASE}/sessions/${id}`, { method: 'DELETE' });
}

/**
 * 发送消息（SSE 流式）
 */
export async function sendMessage(
  sessionId: string,
  message: string,
  { onChunk, onDone, onError }: ChatStreamHandlers
): Promise<void> {
  const response = await fetch(`${API_BASE}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message }),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => 'Request failed');
    onError?.(err);
    return;
  }

  // Response.body 在 DOM 类型里是 ReadableStream | null
  if (!response.body) {
    onError?.('响应无 body，无法进行流式读取');
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;

      try {
        const data = JSON.parse(trimmed.slice(6)) as ChatEvent;
        if (data.type === 'chunk') {
          onChunk?.(data.content);
        } else if (data.type === 'done') {
          onDone?.(data.content);
        } else if (data.type === 'error') {
          onError?.(data.content);
        }
      } catch {
        // 跳过无法解析的行
      }
    }
  }
}
