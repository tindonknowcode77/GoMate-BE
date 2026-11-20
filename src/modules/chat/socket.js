import { Server } from 'socket.io'
import { hashToken } from '../auth/token.js'

// REST owns durable writes/history. Sockets use Socket.IO rooms for O(1) scoped
// delivery of authorized snapshots, delta message payloads, and invalidations;
// a reconnect always reads durable state again.
export function attachChatSockets(server, config, repository, authRepository, { reconcileMs = 30000 } = {}) {
  const io = new Server(server, { cors: { origin: config.corsOrigin }, maxHttpBufferSize: 4096 })
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return next(new Error('Authentication required'))
      const tokenHash = hashToken(token), session = await authRepository.findSession(tokenHash)
      if (!session) return next(new Error('Invalid session'))
      socket.data.userId = session.user.id; socket.data.tokenHash = tokenHash
      next()
    } catch { next(new Error('Authentication unavailable')) }
  })

  // Single server-level listeners dispatch via Socket.IO rooms instead of O(N) per-socket listeners.
  const onConversation = (id, payload) => {
    if (payload?.message) io.to(`conv:${id}`).emit('chat.message', { conversationId: id, message: payload.message })
    void io.in(`conv:${id}`).fetchSockets().then(sockets => {
      for (const s of sockets) void s.data.refreshConversation?.(id)
    })
  }
  const onActivity = activityId => {
    if (activityId) {
      void io.in(`activity:${activityId}`).fetchSockets().then(sockets => {
        for (const s of sockets) {
          for (const [convId, state] of s.data.subscriptions?.entries() ?? []) {
            if (!state.activityId || state.activityId === activityId) void s.data.refreshConversation?.(convId)
          }
        }
      })
      return
    }
    void io.fetchSockets().then(sockets => {
      for (const s of sockets) {
        for (const convId of s.data.subscriptions?.keys() ?? []) void s.data.refreshConversation?.(convId)
      }
    })
  }
  const onUser = id => { io.to(`user:${id}`).emit('user.updated') }
  repository.events.on('conversation', onConversation)
  repository.events.on('activity', onActivity)
  repository.events.on('user', onUser)

  io.on('connection', socket => {
    const subscriptions = new Map()
    socket.data.subscriptions = subscriptions
    void socket.join(`user:${socket.data.userId}`)
    let checking = false
    const refresh = async id => {
      const state = subscriptions.get(id)
      if (!state || !socket.connected) return
      if (state.running) { state.queued = true; return }
      state.running = true
      try {
        if (!await authRepository.findSession(socket.data.tokenHash)) { socket.emit('session.revoked'); socket.disconnect(true); return }
        const snapshot = await repository.snapshot(id, socket.data.userId)
        if (subscriptions.get(id) !== state || !socket.connected) return
        if (snapshot?.activityId && state.activityId !== snapshot.activityId) {
          state.activityId = snapshot.activityId
          void socket.join(`activity:${snapshot.activityId}`)
        }
        const signature = JSON.stringify(snapshot)
        if (signature !== state.signature) {
          state.signature = signature
          socket.emit('conversation.updated', snapshot)
        }
      } catch (error) {
        if ([401, 403, 404].includes(error.status)) {
          subscriptions.delete(id)
          void socket.leave(`conv:${id}`)
          socket.emit('conversation.revoked', { id, status: error.status })
        } else socket.emit('conversation.error', { id, status: 503 })
      } finally {
        state.running = false
        if (state.queued) { state.queued = false; void refresh(id) }
      }
    }
    socket.data.refreshConversation = refresh
    socket.on('conversation.subscribe', async (id, ack) => {
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !subscriptions.has(id) && subscriptions.size >= 5) {
        if (typeof ack === 'function') ack({ error: 'Invalid subscription' })
        return
      }
      if (!subscriptions.has(id)) subscriptions.set(id, { running: false, queued: false, activityId: null })
      void socket.join(`conv:${id}`)
      await refresh(id)
      if (typeof ack === 'function') ack({ ok: subscriptions.has(id) })
    })
    socket.on('conversation.unsubscribe', id => {
      const state = subscriptions.get(id)
      subscriptions.delete(id)
      void socket.leave(`conv:${id}`)
      if (state?.activityId) void socket.leave(`activity:${state.activityId}`)
    })
    const timer = setInterval(async () => {
      if (checking) return
      checking = true
      try {
        if (!await authRepository.findSession(socket.data.tokenHash)) { socket.emit('session.revoked'); socket.disconnect(true); return }
        for (const id of subscriptions.keys()) void refresh(id)
        // Repairs missed notifications from another API process without a broker.
        socket.emit('user.reconcile')
      } catch { /* A transient DB failure must not log the user out. */ }
      finally { checking = false }
    }, reconcileMs)
    timer.unref()
    socket.once('disconnect', () => {
      clearInterval(timer); subscriptions.clear()
    })
  })
  const origClose = io.close.bind(io)
  io.close = cb => {
    repository.events.off('conversation', onConversation)
    repository.events.off('activity', onActivity)
    repository.events.off('user', onUser)
    return origClose(cb)
  }
  return io
}
