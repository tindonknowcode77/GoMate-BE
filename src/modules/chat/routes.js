import express, { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { authenticate } from '../../middlewares/authenticate.js'
import { HttpError } from '../../common/http-error.js'

function fields(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== keys.length ||
    keys.some(key => typeof body[key] !== 'string') || Object.keys(body).some(key => !keys.includes(key))) throw new HttpError(400, 'Invalid request body')
}
function id(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) }
function cursor(value) { return typeof value === 'string' && /^[a-f0-9]{24}$/.test(value) }
function query(req, keys) {
  if (Object.entries(req.query).some(([key, value]) => !keys.includes(key) || typeof value !== 'string')) throw new HttpError(400, 'Invalid query parameters')
}
function integer(value, fallback, max) {
  if (value === undefined) return fallback
  if (!/^[1-9]\d*$/.test(value) || Number(value) > max) throw new HttpError(400, 'Invalid pagination')
  return Number(value)
}

export function createChatRouter(repository, authRepository, { streamIntervalMs = 1000 } = {}) {
  const router = Router(), streams = new Map()
  router.use(authenticate(authRepository))
  router.use(express.json({ limit: '16kb' }))
  const writes = rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false })
  router.post('/', writes, async (req, res) => {
    if (!['direct', 'group'].includes(req.body?.type)) throw new HttpError(400, 'type must be direct or group')
    const key = req.body.type === 'direct' ? 'userId' : 'activityId'
    fields(req.body, ['type', key])
    if (!id(req.body[key])) throw new HttpError(400, 'Invalid target ID')
    res.status(200).json({ conversation: await repository.create(req.auth.user.id, req.body) })
  })
  router.get('/', async (req, res) => {
    query(req, ['page', 'limit'])
    res.json(await repository.list(req.auth.user.id, integer(req.query.page, 1, 500), integer(req.query.limit, 20, 50)))
  })
  router.get('/:id/messages', async (req, res) => {
    query(req, ['before', 'limit'])
    if (req.query.before !== undefined && !cursor(req.query.before)) throw new HttpError(400, 'Invalid cursor')
    res.json(await repository.history(req.params.id, req.auth.user.id, { before: req.query.before, limit: integer(req.query.limit, 30, 100) }))
  })
  router.post('/:id/messages', writes, async (req, res) => {
    fields(req.body, ['text', 'clientMessageId'])
    if (!req.body.text.trim() || req.body.text.length > 4000 || !id(req.body.clientMessageId)) throw new HttpError(400, 'Text must be 1-4000 characters; provide a unique clientMessageId')
    res.status(200).json({ message: await repository.send(req.params.id, req.auth.user.id, { ...req.body, text: req.body.text.trim() }) })
  })
  router.patch('/:id/read', writes, async (req, res) => {
    fields(req.body, ['messageId'])
    if (!cursor(req.body.messageId)) throw new HttpError(400, 'Invalid messageId')
    res.json({ conversation: await repository.markRead(req.params.id, req.auth.user.id, req.body.messageId) })
  })
  router.get('/:id/events', async (req, res) => {
    query(req, [])
    const userId = req.auth.user.id
    await repository.access(req.params.id, userId)
    if ((streams.get(userId) ?? 0) >= 5) throw new HttpError(429, 'Maximum five chat streams per user per server')
    streams.set(userId, (streams.get(userId) ?? 0) + 1)
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store', 'X-Accel-Buffering': 'no' })
    res.flushHeaders()
    let closed = false, timer, last = '', heartbeat = Date.now()
    const started = Date.now()
    const close = () => {
      if (closed) return
      closed = true; clearTimeout(timer)
      const count = (streams.get(userId) ?? 1) - 1
      if (count) streams.set(userId, count); else streams.delete(userId)
      res.end()
    }
    res.on('close', close)
    const emit = (event, data) => {
      if (!closed && !res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) close()
    }
    async function tick() {
      try {
        if (closed) return
        if (Date.now() - started > 300000) { emit('reconnect', {}); close(); return }
        if (!await authRepository.findSession(req.auth.tokenHash)) { emit('access-revoked', { status: 401 }); close(); return }
        const snapshot = await repository.snapshot(req.params.id, userId)
        // Snapshot notifications survive restarts/multiple API instances without an in-memory event bus.
        const signature = JSON.stringify(snapshot)
        if (signature !== last) { emit('conversation.updated', snapshot); last = signature }
        else if (Date.now() - heartbeat > 15000) { if (!res.write(': heartbeat\n\n')) close(); heartbeat = Date.now() }
      } catch (error) {
        if (!closed) { emit(error.status === 403 || error.status === 404 ? 'access-revoked' : 'stream-error', { status: error.status ?? 500 }); close() }
      }
      if (!closed) timer = setTimeout(tick, streamIntervalMs)
    }
    void tick()
  })
  return router
}
