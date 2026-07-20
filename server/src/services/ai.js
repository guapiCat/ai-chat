class AIService {
  constructor() {
    this.apiKey = process.env.AI_API_KEY || '';
    this.baseUrl = process.env.AI_BASE_URL || 'https://api.openai.com/v1';
    this.model = process.env.AI_MODEL || 'gpt-3.5-turbo';
  }

  /**
   * 调用大模型 API 并流式返回内容
   * @param {Array} messages - 消息历史 [{role, content}, ...]
   * @param {Function} onChunk - 每段内容的回调
   */
  async chatStream(messages, onChunk) {
    if (!this.apiKey || this.apiKey === 'sk-your-api-key-here') {
      // 没有配置 API Key 时，用模拟数据让前端能跑起来
      return this._mockStream(messages, onChunk);
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
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`API ${response.status}: ${text.slice(0, 200)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') return;

        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.delta?.content || '';
          if (content) onChunk(content);
        } catch {
          // 跳过非 JSON 行
        }
      }
    }
  }

  /**
   * 无 API Key 时的模拟流式响应
   */
  async _mockStream(messages, onChunk) {
    const userMsg = messages[messages.length - 1]?.content || '';
    const reply = this._generateMockReply(userMsg);
    const tokens = reply.split('');

    for (let i = 0; i < tokens.length; i++) {
      await new Promise(r => setTimeout(r, 30 + Math.random() * 20));
      onChunk(tokens[i]);
    }
  }

  _generateMockReply(msg) {
    const replies = [
      `你好！我是 AI 助手。关于"${msg.slice(0, 20)}"... 这是一个很好的问题。\n\n从技术角度来看，这个问题涉及多个方面需要考虑。首先我们需要明确需求和边界条件，然后选择合适的实现方案。\n\n在实际开发中，我建议采用渐进式的方式：先做一个最小可行产品，然后根据反馈逐步迭代优化。这样做的好处是可以快速验证想法，降低风险。\n\n你目前的思路方向是对的，如果在具体实现中遇到问题，我们可以一起讨论解决。`,
      `感谢你的提问！关于"${msg.slice(0, 20)}"，我理解你的关注点。\n\n这个问题可以从以下几个角度来分析：\n\n1. **技术选型方面**：选择成熟稳定的技术栈可以降低项目风险\n2. **架构设计方面**：保持模块化和可扩展性很重要\n3. **性能优化方面**：提前考虑可能的瓶颈，做好预案\n\n如果你有更具体的场景或需求，可以进一步告诉我，我来帮你分析。`,
    ];
    return replies[Math.floor(Math.random() * replies.length)];
  }
}

module.exports = new AIService();
