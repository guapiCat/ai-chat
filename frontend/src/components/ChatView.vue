<template>
  <div class="chat-view">
    <!-- 消息列表 -->
    <div class="message-list" ref="listRef">
      <div v-for="(msg, i) in messages" :key="i" class="message" :class="msg.role">
        <div class="avatar">{{ msg.role === 'user' ? 'U' : 'AI' }}</div>
        <div class="bubble">
          <div class="content" v-html="renderMarkdown(msg.content)"></div>
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
        <button
          class="btn-send"
          :disabled="!inputText.trim() || streaming"
          @click="handleSubmit"
        >
          {{ streaming ? '...' : '发送' }}
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
  scrollToBottom()
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
  await nextTick()
  scrollToBottom()

  try {
    await sendMessage(props.session.id, text, {
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
    cancelFlush()
    error.value = e instanceof Error ? e.message : '请求失败，请检查后端是否启动'
    streaming.value = false
  }
}

function scrollToBottom() {
  nextTick(() => {
    if (listRef.value) {
      listRef.value.scrollTop = listRef.value.scrollHeight
    }
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

.message-list {
  flex: 1;
  overflow-y: auto;
  padding: 24px 16px;
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

.streaming-hint {
  text-align: center;
  font-size: 12px;
  color: #999;
  margin-top: 8px;
}
</style>
