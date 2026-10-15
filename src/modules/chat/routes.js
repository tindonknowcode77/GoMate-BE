import multer from 'multer'
import { messageContent, validateUpload } from './content.js'
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
  router.get('/:id', async (req, res) => { query(req, []); res.json({ conversation: await repository.snapshot(req.params.id, req.auth.user.id) }) })
  router.get('/:id/messages', async (req, res) => {
    query(req, ['before', 'limit'])
    if (req.query.before !== undefined && !cursor(req.query.before)) throw new HttpError(400, 'Invalid cursor')
    res.json(await repository.history(req.params.id, req.auth.user.id, { before: req.query.before, limit: integer(req.query.limit, 30, 100) }))
  })
  router.post('/:id/messages', writes, async (req, res) => {
    res.status(200).json({ message: await repository.send(req.params.id, req.auth.user.id, messageContent(req.body)) })
  })
  const uploadLimit = rateLimit({ windowMs: 60000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false })
  const multipart = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0, parts: 1 } }).single('file')
  router.post('/:id/attachments', uploadLimit, async (req, _res, next) => { await repository.access(req.params.id, req.auth.user.id); next() }, (req, res, next) => multipart(req, res, error => next(error ? new HttpError(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400, 'Tệp tối đa 10 MB; chọn một tệp mỗi lần tải.') : undefined)), async (req, res) => {
    const metadata = await validateUpload(req.file)
    res.status(201).json({ attachment: await repository.upload(req.params.id, req.auth.user.id, req.file.buffer, metadata) })
  })
  router.get('/:id/attachments/:fileId', async (req, res) => {
    if (!cursor(req.params.fileId)) throw new HttpError(400, 'Invalid attachment ID')
    const file = await repository.attachment(req.params.id, req.auth.user.id, req.params.fileId)
    res.set({ 'Content-Type': file.mimeType, 'Content-Length': String(file.size), 'Cache-Control': 'private, no-store', 'Content-Disposition': `${file.kind === 'image' || file.kind === 'video' || file.kind === 'audio' ? 'inline' : 'attachment'}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(file.name)}`, 'X-Content-Type-Options': 'nosniff' })
    const data = Buffer.from(file.data.buffer)
    res.set('Accept-Ranges', 'bytes')
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range)
      let start, end
      if (match && (match[1] || match[2])) {
        start = match[1] ? Number(match[1]) : Math.max(0, data.length - Number(match[2]))
        end = match[1] ? (match[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1) : data.length - 1
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= data.length) { res.status(416).set('Content-Range', `bytes */${data.length}`).end(); return }
      res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': String(end - start + 1) }).send(data.subarray(start, end + 1)); return
    }
    res.send(data)
  })
  router.get('/:id/shared', async (req, res) => {
    query(req, ['kind', 'before', 'limit'])
    if (!['media', 'files', 'links', 'locations'].includes(req.query.kind) || (req.query.before !== undefined && !cursor(req.query.before))) throw new HttpError(400, 'Invalid shared content filter')
    res.json(await repository.shared(req.params.id, req.auth.user.id, { kind: req.query.kind, before: req.query.before, limit: integer(req.query.limit, 30, 50) }))
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
