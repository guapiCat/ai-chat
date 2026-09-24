import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { sendMessage } from '../src/api';

// 含 4 字节 emoji（UTF-16 里是代理对）与多字节汉字，专门去踩编码边界。
// 所有用例都以「字节」为单位切分，而不是字符——只有按字节切，
// 才可能把多字节字符切成两半，这正是 TextDecoder({stream:true}) 要扛的场景。
const SAMPLE = '你好🙂，跨 chunk 截断验证。';

const globalWithFetch = globalThis as unknown as { fetch: typeof fetch };
const realFetch = globalWithFetch.fetch;

// 测试把全局 fetch 换成了假的，收尾必须还原
after(() => {
  globalWithFetch.fetch = realFetch;
});

// ===== 造帧 =====

function chunkFrame(content: string): string {
  return `data: ${JSON.stringify({ type: 'chunk', content })}`;
}

function doneFrame(content: string): string {
  return `data: ${JSON.stringify({ type: 'done', content })}`;
}

function errorFrame(message: string): string {
  return `data: ${JSON.stringify({ type: 'error', content: message })}`;
}

/** 用 sep 连接若干原始帧；terminate=false 用来模拟流在中途被截断 */
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

// 从 Response 构造函数推导 body 的类型，而不是写死 BodyInit
type ResponseBody = ConstructorParameters<typeof Response>[0];

interface Collected {
  chunks: string;
  doneContent: string | null;
  doneCount: number;
  error: string | null;
}

/** 装好假响应，跑一次 sendMessage，把三个回调的调用情况收集起来 */
async function runWith(makeBody: () => ResponseBody, status = 200): Promise<Collected> {
  globalWithFetch.fetch = async () => new Response(makeBody(), { status });

  const result: Collected = { chunks: '', doneContent: null, doneCount: 0, error: null };
  await sendMessage('s1', 'hi', {
    onChunk: (chunk) => {
      result.chunks += chunk;
    },
    onDone: (full) => {
      result.doneContent = full;
      result.doneCount += 1;
    },
    onError: (message) => {
      result.error = message;
    },
  });
  return result;
}

// ===== 跨 chunk 截断 =====

test('任意字节位置被切开，chunk 与 done 都不丢失', async () => {
  const text = body([chunkFrame(SAMPLE), doneFrame(SAMPLE)]);
  const splits = splitAtEveryByte(text);

  for (let i = 0; i < splits.length; i++) {
    const chunks = splits[i];
    assert.ok(chunks);
    const got = await runWith(() => streamOf(chunks));

    assert.equal(got.chunks, SAMPLE, `在第 ${i} 字节处切分时 chunk 不一致`);
    assert.equal(got.doneCount, 1, `在第 ${i} 字节处切分时 done 触发次数异常`);
    assert.equal(got.doneContent, SAMPLE, `在第 ${i} 字节处切分时 done 内容不一致`);
  }
});

test('逐字节投喂多事件流，chunk 顺序与内容保持不变', async () => {
  const frames = [...SAMPLE].map(chunkFrame);
  frames.push(doneFrame(SAMPLE));

  const got = await runWith(() => streamOf(oneByteChunks(body(frames))));

  assert.equal(got.chunks, SAMPLE);
  assert.equal(got.doneCount, 1);
  assert.equal(got.error, null);
});

test('done 帧没有换行收尾时仍然触发 onDone', async () => {
  // 不补这一步的后果是 onDone 永不触发，界面永远停在“AI 正在生成...”
  const frames = [...SAMPLE].map(chunkFrame);
  frames.push(doneFrame(SAMPLE));

  const got = await runWith(() => streamOf(oneByteChunks(body(frames, '\n\n', false))));

  assert.equal(got.doneCount, 1);
  assert.equal(got.doneContent, SAMPLE);
});

test('末尾 chunk 帧没有换行收尾时，最后一个字不丢', async () => {
  const frames = [...SAMPLE].map(chunkFrame);

  const got = await runWith(() => streamOf(oneByteChunks(body(frames, '\n\n', false))));

  assert.equal(got.chunks, SAMPLE);
  assert.equal(got.doneCount, 0); // 这一轮本来就没有 done 帧
});

// ===== 帧的变体 =====

test('data: 与 JSON 之间没有空格也能解析', async () => {
  const frame = `data:${JSON.stringify({ type: 'chunk', content: SAMPLE })}`;

  const got = await runWith(() => streamOf(oneByteChunks(body([frame]))));

  assert.equal(got.chunks, SAMPLE);
});

test('非 data: 行（注释、event 字段）被忽略', async () => {
  const frames = [': keep-alive', 'event: message', chunkFrame(SAMPLE), doneFrame(SAMPLE)];

  const got = await runWith(() => streamOf(oneByteChunks(body(frames))));

  assert.equal(got.chunks, SAMPLE);
  assert.equal(got.error, null);
});

test('未知事件类型被忽略，不报错', async () => {
  const frame = `data: ${JSON.stringify({ type: 'heartbeat', content: 'x' })}`;

  const got = await runWith(() => streamOf(oneByteChunks(body([frame]))));

  assert.equal(got.chunks, '');
  assert.equal(got.error, null);
  assert.equal(got.doneCount, 0);
});

// ===== 坏数据的处理 =====

test('畸形 JSON 被跳过并告警，不影响其他 chunk', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const frames = [chunkFrame('A'), 'data: {这不是 JSON', chunkFrame('B'), doneFrame('AB')];

  const got = await runWith(() => streamOf(oneByteChunks(body(frames))));

  assert.equal(got.chunks, 'AB');
  assert.equal(got.doneContent, 'AB');
  assert.equal(warn.mock.callCount(), 1);
});

test('空 data: 是心跳，既不产出内容也不告警', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});

  const got = await runWith(() => streamOf(oneByteChunks(body(['data:']))));

  assert.equal(got.chunks, '');
  assert.equal(warn.mock.callCount(), 0);
});

// ===== 错误分支 =====

test('error 事件走 onError，不触发 onDone', async () => {
  const got = await runWith(() => streamOf(oneByteChunks(body([errorFrame('上游炸了')]))));

  assert.equal(got.error, '上游炸了');
  assert.equal(got.doneCount, 0);
});

test('HTTP 非 2xx 时走 onError 并带上响应体原文', async () => {
  const got = await runWith(() => 'Bad Request', 400);

  assert.equal(got.error, 'Bad Request');
  assert.equal(got.chunks, '');
  assert.equal(got.doneCount, 0);
});

test('响应没有 body 时走 onError', async () => {
  const got = await runWith(() => null);

  assert.equal(got.error, '响应无 body，无法进行流式读取');
  assert.equal(got.doneCount, 0);
});

// ===== 请求形状 =====

test('请求形状：POST /api/chat/send，sessionId 与 message 透传', async () => {
  let seenUrl = '';
  let seenInit: RequestInit | undefined;
  globalWithFetch.fetch = async (input, init) => {
    seenUrl = String(input);
    seenInit = init;
    return new Response(streamOf(oneByteChunks(body([doneFrame(SAMPLE)]))), { status: 200 });
  };

  await sendMessage('sess-9', '你好', { onDone: () => {} });

  assert.equal(seenUrl, '/api/chat/send');
  assert.equal(seenInit?.method, 'POST');

  const payload = JSON.parse(String(seenInit?.body)) as { sessionId: string; message: string };
  assert.deepEqual(payload, { sessionId: 'sess-9', message: '你好' });
});

// ===== 中断 =====

test('abort 后以 AbortError 落败，且不走 onError', async () => {
  const abort = new AbortController();
  let resolveFirst: () => void = () => {};
  const firstChunk = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });

  // 假 fetch 要如实响应 abort，否则 reader.read() 不会失败，测试会挂住
  globalWithFetch.fetch = async (_input, init) => {
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        c.enqueue(encoder.encode(body([chunkFrame('前半'), chunkFrame('后半')])));
        // 故意不 close：上游还在生成
      },
    });

    init?.signal?.addEventListener('abort', () => {
      controller?.error(new DOMException('The operation was aborted.', 'AbortError'));
    });

    return new Response(stream, { status: 200 });
  };

  let received = '';
  let doneCalled = false;
  let errorCalled: string | null = null;

  const pending = sendMessage('s1', 'hi', {
    signal: abort.signal,
    onChunk: (chunk) => {
      received += chunk;
      resolveFirst();
    },
    onDone: () => {
      doneCalled = true;
    },
    onError: (message) => {
      errorCalled = message;
    },
  });

  await firstChunk;
  abort.abort();

  await assert.rejects(
    pending,
    (e: unknown) => e instanceof Error && e.name === 'AbortError'
  );

  assert.equal(errorCalled, null, 'abort 不能走 onError，否则「停止」会被显示成报错');
  assert.equal(doneCalled, false);
  assert.ok(received.length > 0, 'abort 之前已收到的内容不该被回滚');
  assert.ok('前半后半'.startsWith(received), '已投递的应当是完整内容的前缀');
});
