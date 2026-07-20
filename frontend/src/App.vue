<template>
  <div class="app-container">
    <Sidebar
      :sessions="sessions"
      :activeId="activeId"
      @select="switchSession"
      @create="handleCreate"
      @delete="handleDelete"
    />
    <ChatView
      v-if="activeSession"
      :key="activeId"
      :session="activeSession"
      @send="handleSend"
    />
    <div v-else class="welcome">
      <div class="welcome-content">
        <div class="logo">AI</div>
        <h1>AI Chat</h1>
        <p>开始一个新对话，或者从左侧选择一个已有会话</p>
        <button class="btn-primary" @click="handleCreate">开始新对话</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import Sidebar from './components/Sidebar.vue'
import ChatView from './components/ChatView.vue'
import { fetchSessions, createSession, deleteSession, fetchSession } from './api.js'

const sessions = ref([])
const activeId = ref(null)

const activeSession = computed(() => {
  if (!activeId.value) return null
  // 从 sessions 列表里找基础信息
  const found = sessions.value.find(s => s.id === activeId.value)
  if (!found) return null
  return found
})

async function loadSessions() {
  try {
    sessions.value = await fetchSessions()
    // 如果当前活跃会话被删了，重置
    if (activeId.value && !sessions.value.find(s => s.id === activeId.value)) {
      activeId.value = null
    }
  } catch (e) {
    console.error('Failed to load sessions', e)
  }
}

async function switchSession(id) {
  activeId.value = id
  // 从后端拉取完整消息
  try {
    const data = await fetchSession(id)
    const session = sessions.value.find(s => s.id === id)
    if (session) {
      session.messages = data.messages || []
    }
  } catch (e) {
    console.error('Failed to load messages', e)
  }
}

async function handleCreate() {
  const { id } = await createSession()
  await loadSessions()
  switchSession(id)
}

async function handleDelete(id) {
  await deleteSession(id)
  await loadSessions()
}

async function handleSend(message) {
  // 消息会通过 ChatView 内部的 SSE 流处理
  // 这里只需要刷新会话列表（标题、消息数可能变了）
  // 实际的消息追加在 ChatView 里完成
}

onMounted(() => {
  loadSessions()
})
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #f0f2f5;
  color: #1a1a2e;
  height: 100vh;
  overflow: hidden;
}

.app-container {
  display: flex;
  height: 100vh;
}

.welcome {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.welcome-content {
  text-align: center;
}

.logo {
  width: 64px;
  height: 64px;
  border-radius: 16px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: #fff;
  font-size: 24px;
  font-weight: bold;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 16px;
}

.welcome h1 {
  font-size: 24px;
  margin-bottom: 8px;
}

.welcome p {
  color: #666;
  margin-bottom: 24px;
}

.btn-primary {
  padding: 10px 24px;
  border: none;
  border-radius: 8px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: #fff;
  font-size: 14px;
  cursor: pointer;
  transition: opacity 0.2s;
}

.btn-primary:hover {
  opacity: 0.9;
}
</style>
