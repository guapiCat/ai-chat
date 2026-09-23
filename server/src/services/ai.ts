// 必须是裸副作用导入，且放在第一行：本模块在顶层读 process.env，
// 且下方的代理设置必须在求值时就能拿到 .env 的值。
// 不能改成 `import dotenv from 'dotenv'` + 函数体内 config()——import 会提升，
// config() 就晚于本模块求值，HTTPS_PROXY 读成空，代理静默失效。
import 'dotenv/config';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import type { Message } from '../types';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';

// Node 内置 fetch 不读 HTTP(S)_PROXY，走代理必须显式挂 dispatcher。
const proxyUrl =
  process.env.HTTPS_PROXY || process.env.https_proxy ||
  process.env.HTTP_PROXY || process.env.http_proxy;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  console.log(`[AI Chat] Using proxy: ${proxyUrl}`);
}

/** 只声明用得到的字段，OpenAI 实际返回远不止这些 */
interface ChatCompletionChunk {
  choices?: Array<{ delta?: { content?: string } }>;
}

interface OpenAIErrorBody {
  error?: { message?: string };
  message?: string;
}

export class AIService {
  private readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;

  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY || '';
    this.baseUrl = (process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = process.env.OPENAI_MODEL || DEFAULT_MODEL;
  }

  get isConfigured(): boolean {
    return Boolean(this.apiKey) && !this.apiKey.startsWith('sk-your');
  }

  /**
   * 调用 OpenAI Chat Completions 并流式返回内容
   * @param messages 消息历史
   * @param onChunk 每段内容的回调
   */
  async chatStream(messages: Message[], onChunk: (chunk: string) => void): Promise<void> {
    if (!this.isConfigured) {
      throw new Error(
        '未配置 OPENAI_API_KEY。请在 server/.env 中填入真实 Key（参考 server/.env.example）后重启服务。'
      );
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`[${response.status}] ${await this._readError(response)}`);
    }
    if (!response.body) {
      throw new Error('响应无 body，无法进行流式读取');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    // 跨 chunk 的不完整尾巴一律留在 buffer 里，等下一块到位再拼。
    // 网络层的切分位置是任意的：可能切在 JSON 中间、切在分隔符的 \r 和 \n 之间，
    // 所以绝不能拿单个 chunk 就地解析——那样每次切分都会丢一段内容。
    let buffer = '';

    /** 处理一个完整事件；返回 false 表示收到 [DONE]，应当结束读取 */
    const handleEvent = (event: string): boolean => {
      // 一个事件可能有多行 data:
      for (const line of event.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const payload = trimmed.slice(5).trim();
        if (!payload) continue; // 空 data: 是心跳，不是错误
        if (payload === '[DONE]') return false;

        try {
          const json = JSON.parse(payload) as ChatCompletionChunk;
          const content = json.choices?.[0]?.delta?.content;
          if (content) onChunk(content);
        } catch {
          // 不能静默吞掉：这里每丢一段都会永久写进会话历史，出问题时需要线索
          console.warn('[AI Chat] 丢弃无法解析的 SSE 数据:', payload.slice(0, 120));
        }
      }
      return true;
    };

    while (true) {
      // 解构不会破坏 done/value 的关联：TS 4.6+ 支持解构可辨识联合的控制流分析，
      // 所以下面 `if (done) break` 之后 value 已收窄为 Uint8Array
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      // SSE 以空行分隔事件，保留最后一段不完整的数据。
      // \r?\n\r?\n 同时兼容 LF 与 CRLF 两种换行
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || '';

      for (const event of events) {
        if (!handleEvent(event)) return;
      }
    }

    // 上游直接断流时，末尾事件可能没有空行收尾，此时它整段还压在 buffer 里。
    // 不补这一步，最后一个 chunk（常常正是收尾的正文）会被丢掉。
    if (buffer.trim()) handleEvent(buffer);
  }

  /** 把 OpenAI 的错误响应转成一句人话 */
  private async _readError(response: Response): Promise<string> {
    const raw = await response.text().catch(() => '');
    try {
      const json = JSON.parse(raw) as OpenAIErrorBody;
      const msg = json.error?.message || json.message;
      if (msg) return `${msg}（model: ${this.model}）`;
    } catch {
      // 不是 JSON，直接截断原文
    }
    return raw.slice(0, 200) || '请求失败';
  }
}

export default new AIService();
