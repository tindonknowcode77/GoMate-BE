import { verificationDocument } from './documents.js'
import { businessIndustries } from './business-options.js'
import { applicationFields, postFields, version } from './validation.js'
import { createBusinessOperationsRouter } from './operations-routes.js'
import express, { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { authenticate } from '../../middlewares/authenticate.js'
import { HttpError } from '../../common/http-error.js'
import { activityCategories, activityFields } from '../activities/validation.js'

function fields(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key))) throw new HttpError(400, 'Invalid request fields')
}
function text(value, max, optional = false) {
  if (optional && (value === undefined || value === '')) return ''
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new HttpError(400, 'Missing or invalid text')
  return value.trim()
}
function choice(value, allowed) { if (!allowed.includes(value)) throw new HttpError(400, 'Invalid value'); return value }
export function createPortalRouter(auth) {
  const router = Router(), repo = auth.portal
  router.use(authenticate(auth))
  router.get('/options', (_req, res) => res.json({ activityCategories, businessIndustries }))
  router.use(async (req, _res, next) => { req.portalRole = await repo.access(req.auth.user.id); next() })
  const allow = (...roles) => (req, _res, next) => { if (!roles.includes(req.portalRole)) throw new HttpError(403, 'Insufficient portal permissions'); next() }
  const writes = rateLimit({ windowMs: 60000, limit: 30, keyGenerator: req => req.auth.user.id, standardHeaders: 'draft-8', legacyHeaders: false })
  const json = express.json({ limit: '32kb' })
  const offset = req => { const page = Number(req.query.page ?? 1); if (!Number.isInteger(page) || page < 1 || page > 10000) throw new HttpError(400, 'Invalid page'); return (page - 1) * 20 }
  router.get('/me', async (req, res) => res.json({ ...await repo.me(req.auth.user.id), role: req.portalRole }))
  router.get('/feed', async (req, res) => res.json(await repo.feed(offset(req), req.auth.user.id)))
  router.post('/applications', allow('user'), writes, express.json({ limit: '28mb' }), async (req, res) => {
    const data = applicationFields(req.body, value => value)
    if (data.document) data.document = await verificationDocument(data.document)
    if (data.supplementalDocument) data.supplementalDocument = await verificationDocument(data.supplementalDocument)
    res.status(201).json(await repo.apply(req.auth.user.id, data))
  })
  router.get('/applications', allow('admin'), async (req, res) => res.json(await repo.applications(offset(req))))
  router.get('/applications/:id/document', async (req, res) => {
    const file = await repo.document(req.params.id, req.auth.user.id, req.portalRole === 'admin', req.query.kind)
    res.set({ 'Content-Type': file.mime, 'Content-Disposition': `attachment; filename="document.${file.mime === 'application/pdf' ? 'pdf' : file.mime === 'image/png' ? 'png' : 'jpg'}"`, 'X-Content-Type-Options': 'nosniff' }).send(Buffer.from(file.base64, 'base64'))
  })
  router.patch('/applications/:id', allow('admin'), writes, json, async (req, res) => {
    fields(req.body, ['status', 'reviewNote', 'version'])
    res.json(await repo.decideApplication(req.params.id, choice(req.body.status, ['approved', 'rejected']), text(req.body.reviewNote, 1000, true), req.auth.user.id, version(req.body.version)))
  })
  router.post('/posts/:id/lifecycle', allow('business', 'admin'), writes, json, async (req,res) => { fields(req.body,['version','action','groupId']); res.json(await repo.postLifecycle(req.params.id,req.auth.user.id,req.portalRole==='admin',version(req.body.version),choice(req.body.action,['withdraw','delete']),req.body.groupId === undefined ? undefined : text(req.body.groupId,100))); })
  router.get('/posts', allow('business', 'admin'), async (req, res) => res.json(await repo.posts(req.portalRole === 'business' ? req.auth.user.id : null, offset(req))))
  router.post('/posts', allow('business'), writes, json, async (req, res) => {
    res.status(201).json(await repo.createPost(req.auth.user.id, postFields(req.body)))
  })
  router.put('/posts/:id', allow('business'), writes, json, async (req, res) => { res.json(await repo.editPost(req.params.id, req.auth.user.id, version(req.body.version), postFields(req.body))) })
  router.delete('/posts/:id', allow('business'), writes, json, async (req, res) => { fields(req.body, ['version']); res.json(await repo.withdrawPost(req.params.id, req.auth.user.id, version(req.body.version))) })
  router.patch('/posts/:id', allow('admin'), writes, json, async (req, res) => {
    fields(req.body, ['status', 'reviewNote', 'version'])
    res.json(await repo.decidePost(req.params.id, choice(req.body.status, ['approved', 'rejected']), text(req.body.reviewNote, 1000, true), req.auth.user.id, version(req.body.version)))
  })
  router.get('/users', allow('admin'), async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 120) : ''
    res.json(await repo.users(offset(req), q))
  })
  router.patch('/users/:id/role', allow('admin'), writes, json, async (req, res) => {
    fields(req.body, ['role'])
    res.json(await repo.setRole(req.params.id, choice(req.body.role, ['user', 'admin']), req.auth.user.id))
  })
  router.patch('/users/:id/subscription', allow('admin'), writes, json, async (req, res) => {
    fields(req.body, ['plan', 'status'])
    res.json(await repo.subscription(req.params.id, { plan: choice(req.body.plan, ['free', 'plus']), status: choice(req.body.status, ['active', 'paused', 'cancelled']) }, req.auth.user.id))
  })
  router.get('/metrics', allow('business', 'admin'), async (req, res) => res.json(await repo.metrics(req.portalRole, req.auth.user.id)))
  router.get('/reports', allow('admin'), async (req, res) => { const items = await auth.community.moderationQueue(); const start = offset(req); res.json({ items: items.slice(start, start + 20), total: items.length }) })
  router.patch('/reports/:id', allow('admin'), writes, json, async (req, res) => {
    fields(req.body, ['status', 'hideActivity'])
    const status = choice(req.body.status, ['resolved', 'dismissed'])
    if (typeof req.body.hideActivity !== 'boolean' || req.body.hideActivity && status !== 'resolved') throw new HttpError(400, 'Invalid report decision')
    res.json(await auth.community.moderate(req.params.id, req.auth.user.id, status, req.body.hideActivity))
  })
  router.get('/tickets', async (req, res) => res.json(await repo.tickets(req.portalRole === 'admin' ? null : req.auth.user.id, offset(req))))
  router.post('/tickets', writes, json, async (req, res) => { fields(req.body, ['subject', 'message']); res.status(201).json(await repo.createTicket(req.auth.user.id, text(req.body.subject, 150), text(req.body.message, 3000))) })
  router.post('/tickets/:id/replies', writes, json, async (req, res) => {
    fields(req.body, ['message', 'status'])
    const admin = req.portalRole === 'admin'
    res.json(await repo.reply(req.params.id, admin ? null : req.auth.user.id, req.auth.user.id, text(req.body.message, 3000), admin ? choice(req.body.status, ['open', 'closed']) : 'open'))
  })
  router.get('/notifications', async (req, res) => res.json(await repo.notifications(req.auth.user.id, offset(req))))
  router.use(createBusinessOperationsRouter(auth))
  return router
}
