import express, { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { authenticate } from '../../middlewares/authenticate.js'
import { HttpError } from '../../common/http-error.js'
export function createFriendRouter(repository) {
  const router = Router()
  router.use(authenticate(repository), express.json({ limit: '4kb' }))
  const writes = rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false })
  const searches = rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false })
  router.get('/search', searches, async (req, res) => {
    if (Object.keys(req.query).some(key => key !== 'q') || typeof req.query.q !== 'string' || req.query.q.trim().length < 2 || req.query.q.length > 60) throw new HttpError(400, 'Nhập ít nhất 2 ký tự tên hoặc Nickname')
    res.json({ items: await repository.searchPeople(req.auth.user.id, req.query.q.trim()) })
  })
  for (const [path, pending] of [['/', false], ['/requests', true]]) router.get(path, async (req, res) => {
    if (Object.keys(req.query).some(key => !['page', 'limit'].includes(key))) throw new HttpError(400, 'Invalid query')
    const page = Number(req.query.page ?? 1), limit = Number(req.query.limit ?? 20)
    if (!Number.isInteger(page) || page < 1 || page > 500 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new HttpError(400, 'Invalid pagination')
    res.json(await repository.listFriends(req.auth.user.id, page, limit, pending))
  })
  router.post('/requests', writes, async (req, res) => {
    const id = req.body?.userId
    if (!req.body || Object.keys(req.body).length !== 1 || typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) || id === req.auth.user.id) throw new HttpError(400, 'Chọn người dùng khác để kết bạn')
    if (!await repository.getProfile(id)) throw new HttpError(404, 'User not found')
    res.json({ request: await repository.friendRequest(req.auth.user.id, id) })
  })
  router.patch('/requests/:id', writes, async (req, res) => {
    if (!req.body || Object.keys(req.body).length !== 1 || !['accepted', 'declined'].includes(req.body.status)) throw new HttpError(400, 'Invalid friend decision')
    const row = await repository.decideFriend(req.auth.user.id, req.params.id, req.body.status)
    if (!row) throw new HttpError(409, 'Chỉ người nhận có thể xử lý lời mời còn chờ')
    res.json({ request: { id: row.id, status: row.status } })
  })
  router.get('/:id', async (req, res) => res.json({ friendship: await repository.friendship(req.auth.user.id, req.params.id) }))
  router.delete('/:id', writes, async (req, res) => { await repository.removeFriend(req.auth.user.id, req.params.id); res.status(204).end() })
  return router
}
