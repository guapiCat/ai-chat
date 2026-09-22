<template>
  <aside class="sidebar">
    <div class="sidebar-header">
      <h2>AI Chat</h2>
      <button class="btn-new" @click="$emit('create')" title="新对话">+</button>
    </div>
    <div class="session-list">
      <div
        v-for="s in sessions"
        :key="s.id"
        class="session-item"
        :class="{ active: s.id === activeId }"
        @click="$emit('select', s.id)"
      >
        <div class="session-title">{{ s.title }}</div>
        <div class="session-meta">
          <span>{{ s.msgCount }} 条消息</span>
          <button
            class="btn-delete"
            @click.stop="$emit('delete', s.id)"
            title="删除对话"
          >×</button>
        </div>
      </div>
      <div v-if="sessions.length === 0" class="empty-hint">
        暂无对话，点击 + 开始
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import type { Session } from '../types'

// 两个 prop 都是必填：App.vue 恒定传入，原先的 default 本就是死代码
defineProps<{
  sessions: Session[]
  activeId: string | null
}>()

defineEmits<{
  select: [id: string]
  create: []
  delete: [id: string]
}>()
</script>

<style scoped>
.sidebar {
  width: 260px;
  background: #1a1a2e;
  color: #fff;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid rgba(255,255,255,0.1);
}

.sidebar-header h2 {
  font-size: 16px;
  font-weight: 600;
}

.btn-new {
  width: 32px;
  height: 32px;
  border: 1px solid rgba(255,255,255,0.2);
  border-radius: 8px;
  background: transparent;
  color: #fff;
  font-size: 18px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s;
}

.btn-new:hover {
  background: rgba(255,255,255,0.1);
}

.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.session-item {
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  margin-bottom: 4px;
  transition: background 0.2s;
}

.session-item:hover {
  background: rgba(255,255,255,0.08);
}

.session-item.active {
  background: rgba(102, 126, 234, 0.25);
}

.session-title {
  font-size: 13px;
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  color: rgba(255,255,255,0.5);
}

.btn-delete {
  background: none;
  border: none;
  color: rgba(255,255,255,0.3);
  cursor: pointer;
  font-size: 14px;
  padding: 0 4px;
  line-height: 1;
}

.btn-delete:hover {
  color: #ff6b6b;
}

.empty-hint {
  text-align: center;
  color: rgba(255,255,255,0.3);
  font-size: 13px;
  padding: 32px 16px;
}
</style>
