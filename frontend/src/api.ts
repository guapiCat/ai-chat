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
 *
 * handlers.signal 用于中断：abort 后本函数以 AbortError 落败，且不会走 onError——
 * 调用方据此把「用户主动停止」和「真的出错了」分开处理。
 */
export async function sendMessage(
  sessionId: string,
  message: string,
  { onChunk, onDone, onError, signal }: ChatStreamHandlers
): Promise<void> {
  const response = await fetch(`${API_BASE}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message }),
    signal,
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
  // 同服务端：一行 SSE 可能被切在任意位置（JSON 中间、行尾的 \n 中间），
  // 不完整的尾巴必须留在 buffer 里等下一块，就近解析会丢掉半行。
  let buffer = '';

  /** 处理一行（已按 \n 切开）；非数据行直接忽略 */
  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    // 后端固定写 "data: "，这里放宽到 "data:"（无空格）以兼容其他实现
    if (!trimmed.startsWith('data:')) return;

    const payload = trimmed.slice(5).trim();
    if (!payload) return;

    try {
      const data = JSON.parse(payload) as ChatEvent;
      if (data.type === 'chunk') {
        onChunk?.(data.content);
      } else if (data.type === 'done') {
        onDone?.(data.content);
      } else if (data.type === 'error') {
        onError?.(data.content);
      }
    } catch {
      // 解析失败意味着有内容缺失，留个痕迹而不是无声吞掉
      console.warn('[SSE] 丢弃无法解析的数据行:', payload.slice(0, 120));
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) handleLine(line);
  }

  // 流提前结束时最后一行可能没有换行收尾。不补这一步，末尾的 done 事件会被丢掉，
  // 界面就会永远停在“AI 正在生成...”上。
  if (buffer.trim()) handleLine(buffer);
}
