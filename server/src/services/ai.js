const { ProxyAgent, setGlobalDispatcher } = require('undici');

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';

// Node 内置 fetch 不读 HTTP(S)_PROXY，走代理必须显式挂 dispatcher。
// 注意：这段依赖 dotenv 已经加载完成（index.js 中先 config 再 require 本模块）。
const proxyUrl =
  process.env.HTTPS_PROXY || process.env.https_proxy ||
  process.env.HTTP_PROXY || process.env.http_proxy;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  console.log(`[AI Chat] Using proxy: ${proxyUrl}`);
}

class AIService {
  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY || '';
    this.baseUrl = (process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = process.env.OPENAI_MODEL || DEFAULT_MODEL;
  }

  get isConfigured() {
    return Boolean(this.apiKey) && !this.apiKey.startsWith('sk-your');
  }

  /**
   * 调用 OpenAI Chat Completions 并流式返回内容
   * @param {Array} messages - 消息历史 [{role, content}, ...]
   * @param {Function} onChunk - 每段内容的回调
   */
  async chatStream(messages, onChunk) {
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
        messages: messages.map(m => ({ role: m.role, content: m.content })),
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
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      // SSE 以空行分隔事件，保留最后一段不完整的数据
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';

      for (const event of events) {
        // 一个事件可能有多行 data:
        for (const line of event.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;

          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') return;

          try {
            const json = JSON.parse(payload);
            const content = json.choices?.[0]?.delta?.content;
            if (content) onChunk(content);
          } catch {
            // 跳过无法解析的行
          }
        }
      }
    }
  }

  /**
   * 把 OpenAI 的错误响应转成一句人话
   */
  async _readError(response) {
    const raw = await response.text().catch(() => '');
    try {
      const json = JSON.parse(raw);
      const msg = json.error?.message || json.message;
      if (msg) return `${msg}（model: ${this.model}）`;
    } catch {
      // 不是 JSON，直接截断原文
    }
    return raw.slice(0, 200) || '请求失败';
  }
}

module.exports = new AIService();
