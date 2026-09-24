import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AIService } from './ai';
import type { Message } from '../types';

// 含 4 字节 emoji（UTF-16 里是代理对）与多字节汉字，专门去踩编码边界。
// 所有用例都以「字节」为单位切分，而不是字符——只有按字节切，
// 才可能把多字节字符切成两半，这正是 TextDecoder({stream:true}) 要扛的场景。
const SAMPLE = '你好🙂，跨 chunk 截断验证。';

const MESSAGES: Message[] = [{ role: 'user', content: 'hi' }];

const globalWithFetch = globalThis as unknown as { fetch: typeof fetch };
const realFetch = globalWithFetch.fetch;

// 测试把全局 fetch 换成了假的，收尾必须还原，否则会影响同进程内的其他用例
after(() => {
  globalWithFetch.fetch = realFetch;
});

beforeEach(() => {
  // AIService 在**构造时**读 env，所以这里赋值对接下来 new 出来的实例一定生效。
  // dotenv 不覆盖已存在的键，因此这两行会盖掉 .env 里的真实配置。
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:1/v1';
});

// ===== 造 SSE 数据 =====

function contentFrame(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`;
}

const DONE_FRAME = 'data: [DONE]';

/** 用 sep 连接若干原始帧；terminate=false 用来模拟流在事件中途被截断 */
function body(frames: string[], sep = '\n\n', terminate = true): string {
  const joined = frames.join(sep);
  return terminate ? joined + sep : joined;
}

// ===== 造字节流 / 假 fetch =====

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function toBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 逐字节一块，让每个字节边界都成为切分点 */
function oneByteChunks(text: string): Uint8Array[] {
  const bytes = toBytes(text);
  return Array.from({ length: bytes.length }, (_, i) => bytes.subarray(i, i + 1));
}

/** 在每个可能的字节位置做一次二切分 */
function splitAtEveryByte(text: string): Uint8Array[][] {
  const bytes = toBytes(text);
  return Array.from({ length: bytes.length + 1 }, (_, i) => [
    bytes.subarray(0, i),
    bytes.subarray(i),
  ]);
}

// 从 Response 构造函数推导 body 的类型，而不是写死 BodyInit：
// 服务端刻意不含 DOM lib，BodyInit 这个全局名在这里并不存在
type ResponseBody = ConstructorParameters<typeof Response>[0];

/** 把假响应装到全局 fetch 上 */
function serve(makeBody: () => ResponseBody, status = 200): void {
  globalWithFetch.fetch = async () => new Response(makeBody(), { status });
}

/** 跑一次 chatStream，收集拼接后的全部内容 */
async function collect(chunks: Uint8Array[]): Promise<string> {
  serve(() => streamOf(chunks));
  let out = '';
  await new AIService().chatStream(MESSAGES, (chunk) => {
    out += chunk;
  });
  return out;
}

// ===== 跨 chunk 截断 =====

test('任意字节位置被切开，内容都不丢失', async () => {
  const text = body([contentFrame(SAMPLE), DONE_FRAME]);
  const splits = splitAtEveryByte(text);

  for (let i = 0; i < splits.length; i++) {
    const chunks = splits[i];
    assert.ok(chunks);
    const got = await collect(chunks);
    assert.equal(got, SAMPLE, `在第 ${i} 字节处切分时内容不一致`);
  }
});

test('逐字节投喂多事件流，内容不丢失', async () => {
  // 每个字符一个事件，模拟真实的逐 token 推送
  const frames = [...SAMPLE].map(contentFrame);
  frames.push(DONE_FRAME);

  const got = await collect(oneByteChunks(body(frames)));
  assert.equal(got, SAMPLE);
});

test('CRLF 分隔符（\\r\\n\\r\\n）也能解析', async () => {
  const frames = [...SAMPLE].map(contentFrame);
  frames.push(DONE_FRAME);

  const got = await collect(oneByteChunks(body(frames, '\r\n\r\n')));
  assert.equal(got, SAMPLE);
});

test('末尾事件没有空行收尾时，最后一段仍会被处理', async () => {
  const frames = [...SAMPLE].map(contentFrame);
  // 不带 [DONE]，且最后一个事件没有分隔符收尾——流被硬截断的样子
  const got = await collect(oneByteChunks(body(frames, '\n\n', false)));
  assert.equal(got, SAMPLE);
});

test('[DONE] 之后的内容不再产出', async () => {
  const text = body([contentFrame(SAMPLE), DONE_FRAME, contentFrame('不应出现')]);
  const got = await collect(oneByteChunks(text));
  assert.equal(got, SAMPLE);
});

// ===== 帧的变体 =====

test('非 data: 行（注释、event、id 字段）被忽略', async () => {
  const frames = [': keep-alive', 'event: message', 'id: 42', contentFrame(SAMPLE), DONE_FRAME];
  const got = await collect(oneByteChunks(body(frames)));
  assert.equal(got, SAMPLE);
});

test('data: 与 JSON 之间没有空格也能解析', async () => {
  const frame = `data:${JSON.stringify({ choices: [{ delta: { content: SAMPLE } }] })}`;
  const got = await collect(oneByteChunks(body([frame, DONE_FRAME])));
  assert.equal(got, SAMPLE);
});

test('单个事件里的多行 data: 都会被处理', async () => {
  const frame = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'AB' } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'CD' } }] })}`,
  ].join('\n');

  const got = await collect(oneByteChunks(body([frame, DONE_FRAME])));
  assert.equal(got, 'ABCD');
});

// ===== 坏数据的处理 =====

test('畸形 JSON 被跳过并告警，不影响其他内容', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const frames = [contentFrame('A'), 'data: {这不是 JSON', contentFrame('B'), DONE_FRAME];

  const got = await collect(oneByteChunks(body(frames)));

  assert.equal(got, 'AB');
  assert.equal(warn.mock.callCount(), 1);
});

test('空 data: 是心跳，既不产出内容也不告警', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const got = await collect(oneByteChunks(body(['data:', contentFrame(SAMPLE), DONE_FRAME])));

  assert.equal(got, SAMPLE);
  assert.equal(warn.mock.callCount(), 0);
});

// ===== 请求与错误分支 =====

test('请求形状：POST 到 /chat/completions，stream 为 true，消息透传', async () => {
  let seenUrl = '';
  let seenInit: RequestInit | undefined;
  globalWithFetch.fetch = async (input, init) => {
    seenUrl = String(input);
    seenInit = init;
    return new Response(streamOf(oneByteChunks(body([DONE_FRAME]))), { status: 200 });
  };

  // 尾部的斜杠应被规范化掉
  process.env.OPENAI_BASE_URL = 'http://example.test/v1/';
  await new AIService().chatStream(MESSAGES, () => {});

  assert.equal(seenUrl, 'http://example.test/v1/chat/completions');
  assert.equal(seenInit?.method, 'POST');

  const payload = JSON.parse(String(seenInit?.body)) as {
    stream: boolean;
    messages: Message[];
  };
  assert.equal(payload.stream, true);
  assert.deepEqual(payload.messages, MESSAGES);
});

test('HTTP 非 2xx：抛出状态码与上游错误消息', async () => {
  serve(() => JSON.stringify({ error: { message: 'invalid api key' } }), 401);

  await assert.rejects(
    () => new AIService().chatStream(MESSAGES, () => {}),
    /\[401\] invalid api key/
  );
});

test('错误响应不是 JSON 时，回退为原文', async () => {
  serve(() => 'upstream timeout', 504);

  await assert.rejects(
    () => new AIService().chatStream(MESSAGES, () => {}),
    /\[504\] upstream timeout/
  );
});

test('响应没有 body 时抛出', async () => {
  serve(() => null);

  await assert.rejects(
    () => new AIService().chatStream(MESSAGES, () => {}),
    /无法进行流式读取/
  );
});

test('未配置 Key 时直接抛出，且不发起请求', async () => {
  let called = false;
  globalWithFetch.fetch = async () => {
    called = true;
    return new Response(null, { status: 200 });
  };

  process.env.OPENAI_API_KEY = 'sk-your-key-here';
  await assert.rejects(
    () => new AIService().chatStream(MESSAGES, () => {}),
    /未配置 OPENAI_API_KEY/
  );

  process.env.OPENAI_API_KEY = '';
  await assert.rejects(
    () => new AIService().chatStream(MESSAGES, () => {}),
    /未配置 OPENAI_API_KEY/
  );

  assert.equal(called, false);
});

test('abort 会让 chatStream 以 AbortError 落败', async () => {
  const abort = new AbortController();
  let delivered = '';
  let resolveFirst: () => void = () => {};
  const firstChunk = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });

  // 假上游要如实响应 abort，否则 reader.read() 永远不会失败，测试会挂住
  globalWithFetch.fetch = async (_input, init) => {
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        c.enqueue(encoder.encode(body([contentFrame('上半'), contentFrame('下半')])));
        // 故意不 close：上游还在生成
      },
    });

    init?.signal?.addEventListener('abort', () => {
      controller?.error(new DOMException('The operation was aborted.', 'AbortError'));
    });

    return new Response(stream, { status: 200 });
  };

  const pending = new AIService().chatStream(
    MESSAGES,
    (chunk) => {
      delivered += chunk;
      resolveFirst();
    },
    abort.signal
  );

  await firstChunk;
  abort.abort();

  await assert.rejects(
    pending,
    (e: unknown) => e instanceof Error && e.name === 'AbortError'
  );

  assert.ok(delivered.length > 0, 'abort 之前已收到的内容不该被回滚');
  assert.ok('上半下半'.startsWith(delivered), '已投递的应当是完整内容的前缀');
});
