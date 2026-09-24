import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import type { Message } from '../types';

// 被换掉的真实 fetch：测试客户端自己要用它去连本进程起的 express
const clientFetch = globalThis.fetch;
const globalWithFetch = globalThis as unknown as { fetch: typeof fetch };

// 上游一次吐这么多段，故意慢慢吐，好在生成到一半时把客户端断开
const PIECES = ['第一段', '第二段', '第三段', '第四段', '第五段'];
const FULL = PIECES.join('');
const UPSTREAM_GAP_MS = 40;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** OpenAI 风格的单事件 */
function upstreamEvent(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

let server: Server;
let base = '';
/** 上游是否真的被取消了——这是「停止生成别白烧 token」的直接证据 */
let upstreamAborted = false;

before(async () => {
  // 必须在动态 import 之前设好：aiService 在模块求值时构造，构造时就读 env。
  // dotenv 不覆盖已存在的键，所以这里能盖掉 .env，让测试不依赖本机配置
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:1/v1';

  const { default: chatRoutes } = await import('./chat');

  // 起真的 HTTP 服务：客户端断开必须是真断开，否则 res 不会派发 close，测不到中断
  const app = express();
  app.use(express.json());
  app.use('/api/chat', chatRoutes);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as { port: number };
  base = `http://127.0.0.1:${address.port}`;
});

after(() => {
  globalWithFetch.fetch = clientFetch;
  server?.close();
});

test('客户端断开：中止上游，并把已生成的部分以 stopped 落库', async () => {
  upstreamAborted = false;

  // 假上游。要如实模拟两件事：body 慢慢产、以及 abort 时请求真的被取消
  globalWithFetch.fetch = async (_input, init) => {
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let index = 0;

    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        const tick = (): void => {
          if (index >= PIECES.length) return; // 故意不 close：上游还在生成
          c.enqueue(encoder.encode(upstreamEvent(PIECES[index] as string)));
          index += 1;
          timer = setTimeout(tick, UPSTREAM_GAP_MS);
        };
        timer = setTimeout(tick, UPSTREAM_GAP_MS);
      },
      cancel() {
        if (timer) clearTimeout(timer);
      },
    });

    const signal = init?.signal;
    if (signal) {
      signal.addEventListener('abort', () => {
        upstreamAborted = true;
        if (timer) clearTimeout(timer);
        // 真实 fetch 被 abort 时，body 会以 AbortError 失败
        controller?.error(new DOMException('The operation was aborted.', 'AbortError'));
      });
    }

    return new Response(stream, { status: 200 });
  };

  const sessionId = 'abort-case';
  const abort = new AbortController();

  const response = await clientFetch(`${base}/api/chat/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message: '你好' }),
    signal: abort.signal,
  });
  assert.equal(response.status, 200);
  assert.ok(response.body);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += decoder.decode(value, { stream: true });
    // 一收到内容就断开，模拟用户点「停止」
    if (received.includes('"type":"chunk"')) {
      abort.abort();
      break;
    }
  }

  // 等服务端把 close 处理完
  await sleep(250);

  assert.ok(received.includes('"type":"chunk"'), '断开前应该已经收到过内容');
  assert.ok(!received.includes('"type":"done"'), '中断的这轮不该有 done 事件');
  assert.equal(upstreamAborted, true, '客户端断开后必须取消上游请求');

  const detail = (await (await clientFetch(`${base}/api/chat/sessions/${sessionId}`)).json()) as {
    messages: Message[];
  };

  assert.equal(detail.messages.length, 2);
  assert.equal(detail.messages[0]?.role, 'user');

  const assistant = detail.messages[1];
  assert.ok(assistant);
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.stopped, true, '中断的回复必须带 stopped 标记');
  assert.ok(assistant.content.length > 0, '已生成的部分要保留下来');
  assert.ok(FULL.startsWith(assistant.content), '落库的应当是已生成部分而不是别的什么');
  assert.ok(
    assistant.content.length < FULL.length,
    '生成应当在中途就停下，不该把整条都跑完'
  );
});
