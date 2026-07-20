const API_BASE = '/api/chat'

/**
 * 获取会话列表
 */
export async function fetchSessions() {
  const res = await fetch(`${API_BASE}/sessions`)
  return res.json()
}

/**
 * 创建新会话
 */
export async function createSession() {
  const res = await fetch(`${API_BASE}/sessions`, { method: 'POST' })
  return res.json()
}

/**
 * 获取会话消息
 */
export async function fetchSession(id) {
  const res = await fetch(`${API_BASE}/sessions/${id}`)
  if (!res.ok) throw new Error('Session not found')
  return res.json()
}

/**
 * 删除会话
 */
export async function deleteSession(id) {
  await fetch(`${API_BASE}/sessions/${id}`, { method: 'DELETE' })
}

/**
 * 发送消息（SSE 流式）
 * @param {string} sessionId
 * @param {string} message
 * @param {function} onChunk - 收到内容块的回调
 * @param {function} onDone - 完成回调
 * @param {function} onError - 错误回调
 */
export async function sendMessage(sessionId, message, { onChunk, onDone, onError }) {
  const response = await fetch(`${API_BASE}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message }),
  })

  if (!response.ok) {
    const err = await response.text().catch(() => 'Request failed')
    onError?.(err)
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data: ')) continue

      try {
        const data = JSON.parse(trimmed.slice(6))
        if (data.type === 'chunk') {
          onChunk?.(data.content)
        } else if (data.type === 'done') {
          onDone?.(data.content)
        } else if (data.type === 'error') {
          onError?.(data.content)
        }
      } catch {
        // skip
      }
    }
  }
}
