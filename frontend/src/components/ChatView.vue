<template>
  <div class="chat-view">
    <!-- 消息列表 -->
    <div class="message-list-wrap">
      <div class="message-list" ref="listRef" @scroll="updateAtBottom">
        <div v-for="(msg, i) in messages" :key="i" class="message" :class="msg.role">
          <div class="avatar">{{ msg.role === 'user' ? 'U' : 'AI' }}</div>
          <div class="bubble">
            <div class="content" v-html="renderMarkdown(msg.content)"></div>
            <div v-if="msg.stopped" class="stopped-tag">已停止</div>
          </div>
        </div>
        <!-- 正在输入的指示器 -->
        <div v-if="streaming" class="message assistant">
          <div class="avatar">AI</div>
          <div class="bubble">
            <div class="content" v-html="renderMarkdown(streamContent)"></div>
            <span class="cursor-blink">▌</span>
          </div>
        </div>
        <!-- 错误提示 -->
        <div v-if="error" class="message system">
          <div class="bubble error-bubble">{{ error }}</div>
        </div>
      </div>
      <!-- 用户往上翻看历史时才浮出来，否则生成过程会一直把他拽回底部 -->
      <button v-if="!atBottom" class="btn-scroll-bottom" @click="scrollToBottom(true)">
        ↓ 回到底部
      </button>
    </div>

    <!-- 输入区 -->
    <div class="input-area">
      <div class="input-wrapper">
        <textarea
          ref="inputRef"
          v-model="inputText"
          @keydown.enter.exact="handleSubmit"
          @input="autoResize"
          placeholder="输入消息..."
          rows="1"
          :disabled="streaming"
        ></textarea>
        <!-- 同一个按钮位：生成中显示「停止」，否则显示「发送」 -->
        <button v-if="streaming" class="btn-send btn-stop" @click="handleStop">
          停止
        </button>
        <button v-else class="btn-send" :disabled="!inputText.trim()" @click="handleSubmit">
          发送
        </button>
      </div>
      <p v-if="streaming" class="streaming-hint">AI 正在生成...</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { sendMessage } from '../api'
import type { Message, Session } from '../types'

const props = defineProps<{ session: Session }>()
const emit = defineEmits<{ send: [text: string] }>()

const messages = ref<Message[]>([])
const inputText = ref('')
const streaming = ref(false)
const streamContent = ref('')
const error = ref('')
const listRef = ref<HTMLElement | null>(null)
const inputRef = ref<HTMLTextAreaElement | null>(null)

// 用户是否贴在消息列表底部。贴底时新内容自动跟随；一旦往上翻看历史就置 false，
// 生成过程不再抢滚动位置，改由「回到底部」按钮把控制权交还给用户
const atBottom = ref(true)

// 距底部多少像素内仍算贴底。scrollTop 取整而 scrollHeight - clientHeight 可能是小数
// （页面缩放、hidpi 下常见），判严格相等会把贴底误判成没贴底，所以留一点容差
const BOTTOM_THRESHOLD = 4

// 中断用。streaming 期间输入被禁用，所以同一时刻只可能有一轮在跑
let abortController: AbortController | null = null

// 流式渲染缓冲：chunk 的到达速度远高于屏幕刷新率，逐块赋值 streamContent
// 会让每个 token 都触发一次响应式更新 + 整段 markdown 重解析 + 重排。
// 改为先攒进 buffer，每帧最多提交一次。
let chunkBuffer = ''
// requestAnimationFrame 在浏览器返回 number
let rafId: number | null = null

function flushChunks() {
  rafId = null
  // 没有新内容就不提交，避免空帧触发无谓的重渲染
  if (!chunkBuffer) return
  streamContent.value += chunkBuffer
  chunkBuffer = ''
  scrollToBottom()
}

function scheduleFlush() {
  // 已有待执行的帧就等着，天然实现了合并多个 chunk 的效果
  if (rafId === null) {
    rafId = requestAnimationFrame(flushChunks)
  }
}

function cancelFlush() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  chunkBuffer = ''
}

/**
 * 收尾专用：先把还没提交的那一帧补进去再撤销。
 * 停止生成时必须用这个而不是 cancelFlush，否则最后不到一帧的内容会跟着缓冲一起丢掉。
 */
function commitFlush() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  flushChunks()
}

// 当切换会话时，加载已有消息
watch(() => props.session.id, async (id) => {
  if (!id) return
  if (props.session.messages) {
    messages.value = [...props.session.messages]
  } else {
    messages.value = []
  }
  error.value = ''
  streamContent.value = ''
  await nextTick()
  // 换会话是明确意图：直接定位到最新一条，不必管切换前的滚动位置
  scrollToBottom(true)
}, { immediate: true })

async function handleSubmit() {
  const text = inputText.value.trim()
  if (!text || streaming.value) return

  inputText.value = ''
  error.value = ''

  // 立即显示用户消息
  messages.value.push({ role: 'user', content: text })

  // 准备流式接收
  streaming.value = true
  cancelFlush()
  streamContent.value = ''
  abortController = new AbortController()
  await nextTick()
  // 发送同样是明确意图：用户就是要看回复，直接跳到底
  scrollToBottom(true)

  try {
    await sendMessage(props.session.id, text, {
      signal: abortController.signal,
      onChunk: (chunk) => {
        chunkBuffer += chunk
        scheduleFlush()
      },
      onDone: (fullContent) => {
        // 后端给的 fullContent 是完整原文，直接丢掉未提交的缓冲，
        // 否则残留的 chunk 会后到一步、追加上去变成重复内容
        cancelFlush()
        messages.value.push({ role: 'assistant', content: fullContent })
        streamContent.value = ''
        streaming.value = false
        emit('send', text)
        scrollToBottom()
      },
      onError: (errMsg) => {
        cancelFlush()
        error.value = errMsg
        streaming.value = false
      },
    })
  } catch (e) {
    if (isAbortError(e)) {
      // 用户点了「停止」：没有完整回复可用了，就把已生成的部分保留下来并打标记
      commitFlush()
      // 一个字都没生成就停了（比如刚点发送就点停止）就不留空消息，
      // 空 content 放进历史喂给模型也没有意义
      if (streamContent.value) {
        messages.value.push({
          role: 'assistant',
          content: streamContent.value,
          stopped: true,
        })
      }
      streamContent.value = ''
      streaming.value = false
      scrollToBottom()
    } else {
      cancelFlush()
      error.value = e instanceof Error ? e.message : '请求失败，请检查后端是否启动'
      streaming.value = false
    }
  } finally {
    abortController = null
  }
}

/** 中断抛的是 AbortError，必须和真正的请求失败区分开，否则停止会被显示成报错 */
function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError'
}

function handleStop() {
  // 只负责发起中止，收尾统一在 handleSubmit 的 catch 里做
  abortController?.abort()
}

/** 滚动时重新判定是否贴底，顺带决定「回到底部」按钮的去留 */
function updateAtBottom() {
  const el = listRef.value
  if (!el) return
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD
}

/**
 * 滚到底部。force=true 用于「发送」「切换会话」「点回到底部」这类明确的用户意图；
 * 流式追加时传 false，此时若用户已经翻上去看历史就不再把他拽回底部。
 * 判定放在 nextTick 里做，尽量贴近真正改 scrollTop 的时刻，免得和用户的滚动抢跑。
 */
function scrollToBottom(force = false) {
  nextTick(() => {
    const el = listRef.value
    if (!el) return
    if (!force && !atBottom.value) return
    el.scrollTop = el.scrollHeight
    atBottom.value = true
  })
}

function autoResize(e: Event) {
  const el = e.target as HTMLTextAreaElement
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 160) + 'px'
}

/**
 * 极简的 markdown 渲染（支持代码块、加粗、列表、换行）
 */
function renderMarkdown(text: string): string {
  if (!text) return ''
  let html = text
    // 转义 HTML
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // 代码块 ```lang\n...```
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_match: string, lang: string, code: string) => {
      return `<pre><code class="language-${lang}">${code.trim()}</code></pre>`
    })
    // 行内代码
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // 加粗
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // 换行
    .replace(/\n/g, '<br>')
  return html
}

onMounted(() => {
  if (inputRef.value) inputRef.value.focus()
})

// 会话切换时组件会因 :key 被销毁，此时可能还有一帧挂着，必须撤掉
onUnmounted(cancelFlush)
</script>

<style scoped>
.chat-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #fff;
}

/* 滚动容器的外层，同时给「回到底部」按钮提供定位上下文 */
.message-list-wrap {
  flex: 1;
  /* flex 子项默认 min-height: auto，不置 0 的话内部撑不出滚动条 */
  min-height: 0;
  position: relative;
}

.message-list {
  height: 100%;
  overflow-y: auto;
  padding: 24px 16px;
  /* 关掉滚动锚定：流式回复每帧整体重写气泡的 innerHTML，锚点节点会被销毁，
     浏览器重选锚点时可能自行挪动 scrollTop，把正在翻历史的用户顶走。
     滚动位置统一由 atBottom 那套逻辑掌管，不需要浏览器代劳 */
  overflow-anchor: none;
}

/* 「回到底部」：浮在消息区底部居中，只在用户翻离底部时出现 */
.btn-scroll-bottom {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 14px;
  border: 1px solid #e0e0e6;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  color: #555;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.2s;
}

.btn-scroll-bottom:hover {
  background: #f0f2f5;
}

.message {
  display: flex;
  margin-bottom: 20px;
  max-width: 800px;
  margin-left: auto;
  margin-right: auto;
  width: 100%;
}

.message.user {
  flex-direction: row-reverse;
}

.avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: bold;
  flex-shrink: 0;
  margin: 0 12px;
}

.message.user .avatar {
  background: linear-gradient(135deg, #667eea, #764ba2);
  color: #fff;
}

.message.assistant .avatar {
  background: linear-gradient(135deg, #f093fb, #f5576c);
  color: #fff;
}

.bubble {
  max-width: 75%;
  padding: 12px 16px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.6;
}

.message.user .bubble {
  background: #667eea;
  color: #fff;
  border-bottom-right-radius: 4px;
}

.message.assistant .bubble {
  background: #f0f2f5;
  color: #1a1a2e;
  border-bottom-left-radius: 4px;
}

/* 用户中途停止生成：正文是截断的，标记出来免得日后当成完整回复 */
.stopped-tag {
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px dashed rgba(0, 0, 0, 0.12);
  font-size: 12px;
  color: #999;
}

.bubble :deep(pre) {
  background: #1a1a2e;
  color: #e8e8e8;
  padding: 12px;
  border-radius: 8px;
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.5;
  margin: 8px 0;
}

.bubble :deep(code) {
  background: rgba(0,0,0,0.06);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 13px;
}

.bubble :deep(pre code) {
  background: none;
  padding: 0;
}

.cursor-blink {
  animation: blink 1s step-end infinite;
  color: #666;
}

@keyframes blink {
  50% { opacity: 0; }
}

.message.system .bubble {
  background: #fff3cd;
  color: #856404;
  border: 1px solid #ffc107;
}

.error-bubble {
  background: #fee !important;
  color: #c33 !important;
  border: 1px solid #fcc !important;
}

.input-area {
  border-top: 1px solid #e8e8e8;
  padding: 16px 24px;
  background: #fafafa;
}

.input-wrapper {
  display: flex;
  gap: 8px;
  max-width: 800px;
  margin: 0 auto;
}

.input-wrapper textarea {
  flex: 1;
  border: 1px solid #ddd;
  border-radius: 10px;
  padding: 10px 14px;
  font-size: 14px;
  font-family: inherit;
  resize: none;
  outline: none;
  transition: border-color 0.2s;
  max-height: 160px;
  line-height: 1.5;
}

.input-wrapper textarea:focus {
  border-color: #667eea;
}

.input-wrapper textarea:disabled {
  background: #f5f5f5;
}

.btn-send {
  padding: 10px 24px;
  border: none;
  border-radius: 10px;
  background: linear-gradient(135deg, #667eea, #764ba2);
  color: #fff;
  font-size: 14px;
  cursor: pointer;
  transition: opacity 0.2s;
  white-space: nowrap;
}

.btn-send:hover:not(:disabled) {
  opacity: 0.9;
}

.btn-send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 生成中复用同一个按钮位，做成次级样式以免和「发送」抢注意力 */
.btn-stop {
  background: #fff;
  color: #555;
  border: 1px solid #ddd;
}

.streaming-hint {
  text-align: center;
  font-size: 12px;
  color: #999;
  margin-top: 8px;
}
</style>
