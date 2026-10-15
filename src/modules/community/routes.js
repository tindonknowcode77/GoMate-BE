import express, { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { authenticate } from '../../middlewares/authenticate.js'
import { HttpError } from '../../common/http-error.js'
import { defaultSettings } from './repository.js'
const isId = value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)
export function createCommunityRouter(auth) {
  const router = Router(), repository = auth.community
  router.use(authenticate(auth), express.json({ limit: '128kb' }))
  const writes = rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false })
  function body(value, keys) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new HttpError(400, 'Dữ liệu không hợp lệ') }
  router.get('/settings', async (req, res) => res.json({ settings: await repository.settings(req.auth.user.id) }))
  router.patch('/settings', writes, async (req, res) => {
    body(req.body, Object.keys(defaultSettings))
    if (!Object.keys(req.body).length || Object.entries(req.body).some(([key, value]) => key === 'directMessages' ? !['everyone', 'friends'].includes(value) : typeof value !== 'boolean')) throw new HttpError(400, 'Tùy chọn không hợp lệ')
    res.json({ settings: await repository.saveSettings(req.auth.user.id, req.body) })
  })
  router.get('/notifications', async (req, res) => {
    const page = Number(req.query.page ?? 1), limit = Number(req.query.limit ?? 30)
    if (Object.keys(req.query).some(key => !['page', 'limit'].includes(key)) || !Number.isInteger(page) || page < 1 || page > 500 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new HttpError(400, 'Phân trang không hợp lệ')
    res.json(await repository.notifications(req.auth.user.id, page, limit))
  })
  router.patch('/notifications/read', writes, async (req, res) => { body(req.body, []); await repository.readNotice(req.auth.user.id); res.status(204).end() })
  router.patch('/notifications/:id/read', writes, async (req, res) => { body(req.body, []); await repository.readNotice(req.auth.user.id, req.params.id); res.status(204).end() })
  router.get('/blocks', async (req, res) => res.json({ items: await repository.listBlocks(req.auth.user.id) }))
  router.put('/blocks/:id', writes, async (req, res) => { body(req.body, []); if (!isId(req.params.id)) throw new HttpError(400, 'Tài khoản không hợp lệ'); await repository.block(req.auth.user.id, req.params.id); res.status(204).end() })
  router.delete('/blocks/:id', writes, async (req, res) => { await repository.unblock(req.auth.user.id, req.params.id); res.status(204).end() })
  const reasons = ['Nội dung không phù hợp', 'Thông tin sai sự thật', 'Quấy rối / thiếu an toàn', 'Hoạt động thương mại / quảng cáo', 'Trùng lặp nội dung', 'Lý do khác']
  router.post('/reports', writes, async (req, res) => {
    body(req.body, ['activityId', 'reason', 'detail'])
    if (!isId(req.body.activityId) || !reasons.includes(req.body.reason) || typeof req.body.detail !== 'string' || req.body.detail.length > 1000) throw new HttpError(400, 'Chọn lý do và mô tả tối đa 1000 ký tự')
    res.status(201).json({ report: await repository.report(req.auth.user.id, { ...req.body, detail: req.body.detail.trim() }) })
  })
  router.get('/reports', async (req, res) => res.json({ items: await repository.reports(req.auth.user.id) }))
  router.use('/moderation', async (req, _res, next) => { if ((await auth.getProfile(req.auth.user.id))?.role !== 'admin') throw new HttpError(403, 'Chỉ quản trị viên có quyền xử lý báo cáo'); next() })
  router.get('/moderation/reports', async (_req, res) => res.json({ items: await repository.moderationQueue() }))
  router.patch('/moderation/reports/:id', writes, async (req, res) => { body(req.body, ['status', 'hideActivity']); if (!['resolved', 'dismissed'].includes(req.body.status) || typeof req.body.hideActivity !== 'boolean' || req.body.hideActivity && req.body.status !== 'resolved') throw new HttpError(400, 'Quyết định xử lý không hợp lệ'); res.json(await repository.moderate(req.params.id, req.auth.user.id, req.body.status, req.body.hideActivity)) })
  router.get('/ratings/:activityId', async (req, res) => res.json(await repository.ratingForm(req.params.activityId, req.auth.user.id)))
  router.post('/ratings/:activityId', writes, async (req, res) => {
    body(req.body, ['score', 'comment', 'members'])
    const { score, comment, members } = req.body
    if (!Number.isInteger(score) || score < 1 || score > 5 || typeof comment !== 'string' || comment.length > 1000 || !Array.isArray(members) || members.length > 999 || new Set(members.map(item => item?.userId)).size !== members.length) throw new HttpError(400, 'Điểm cần từ 1 đến 5, nhận xét tối đa 1000 ký tự')
    for (const item of members) { body(item, ['userId', 'score']); if (!isId(item.userId) || !Number.isInteger(item.score) || item.score < 1 || item.score > 5) throw new HttpError(400, 'Đánh giá thành viên không hợp lệ') }
    res.json(await repository.rate(req.params.activityId, req.auth.user.id, { score, comment: comment.trim(), members: [...members].sort((a, b) => a.userId.localeCompare(b.userId)) }))
  })
  return router
}
