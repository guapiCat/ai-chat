// 与 server/src/types.ts 对应的前后端 HTTP 契约。
// 两边改动需同步（刻意不为这几十行类型搭 monorepo）。

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  /** 用户中途停止了生成：此时的 content 只是已生成的部分内容 */
  stopped?: boolean;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  msgCount: number;
  /** 列表接口不返回，由 switchSession 拉详情后在客户端补挂 */
  messages?: Message[];
}

/** 与后端 SSE 帧一一对应；用可辨识联合，收窄靠类型而非字符串猜 */
export type ChatEvent =
  | { type: 'chunk'; content: string }
  | { type: 'done'; content: string }
  | { type: 'error'; content: string };

export interface ChatStreamHandlers {
  onChunk?: (chunk: string) => void;
  onDone?: (fullContent: string) => void;
  onError?: (message: string) => void;
  /**
   * 中断用。abort 之后 sendMessage 会以 AbortError 落败，
   * 且不会走 onError——「用户主动停止」和「真的出错了」要区别对待，
   * 收尾方式由调用方决定
   */
  signal?: AbortSignal;
}
