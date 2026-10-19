import express, { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { authenticate } from '../../middlewares/authenticate.js'
import { HttpError } from '../../common/http-error.js'
import { activityFields } from '../activities/validation.js'

function fields(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key))) throw new HttpError(400, 'Invalid request fields')
}
function text(value, max, optional = false) {
  if (optional && (value === undefined || value === '')) return ''
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new HttpError(400, 'Missing or invalid text')
  return value.trim()
}
function choice(value, allowed) { if (!allowed.includes(value)) throw new HttpError(400, 'Invalid value'); return value }
function document(value) {
  fields(value, ['name', 'mime', 'base64'])
  const name = text(value.name, 180), mime = choice(value.mime, ['application/pdf', 'image/png', 'image/jpeg'])
  if (typeof value.base64 !== 'string' || value.base64.length > 13981016 || value.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.base64)) throw new HttpError(400, 'Invalid document')
  const bytes = Buffer.from(value.base64, 'base64')
  if (!bytes.length || bytes.length > 10 * 1024 * 1024 || bytes.toString('base64') !== value.base64) throw new HttpError(400, 'Document must be valid base64 and at most 10 MB')
  const valid = mime === 'application/pdf' ? bytes.subarray(0, 5).toString() === '%PDF-' : mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if (!valid) throw new HttpError(400, 'Document type does not match its contents')
  return { name, mime, base64: value.base64 }
}
export function createPortalRouter(auth) {
  const router = Router(), repo = auth.portal
  router.use(authenticate(auth))
  router.use(async (req, _res, next) => { req.portalRole = await repo.access(req.auth.user.id); next() })
  const allow = (...roles) => (req, _res, next) => { if (!roles.includes(req.portalRole)) throw new HttpError(403, 'Insufficient portal permissions'); next() }
  const writes = rateLimit({ windowMs: 60000, limit: 30, keyGenerator: req => req.auth.user.id, standardHeaders: 'draft-8', legacyHeaders: false })
  const json = express.json({ limit: '32kb' })
  const offset = req => { const page = Number(req.query.page ?? 1); if (!Number.isInteger(page) || page < 1 || page > 10000) throw new HttpError(400, 'Invalid page'); return (page - 1) * 20 }
  router.get('/me', async (req, res) => res.json({ ...await repo.me(req.auth.user.id), role: req.portalRole }))
  router.get('/feed', async (req, res) => res.json(await repo.feed(offset(req))))
  router.post('/applications', allow('user'), writes, express.json({ limit: '14mb' }), async (req, res) => {
    fields(req.body, ['company', 'website', 'category', 'document'])
    const website = text(req.body.website, 500, true)
    if (website) { let url; try { url = new URL(website) } catch { throw new HttpError(400, 'Invalid website URL') }; if (!['https:', 'http:'].includes(url.protocol)) throw new HttpError(400, 'Invalid website URL') }
    res.status(201).json(await repo.apply(req.auth.user.id, { company: text(req.body.company, 150), category: text(req.body.category, 100), website, document: document(req.body.document) }))
  })
  router.get('/applications', allow('staff', 'admin'), async (req, res) => res.json(await repo.applications(offset(req))))
  router.get('/applications/:id/document', allow('staff', 'admin'), async (req, res) => {
    const file = await repo.document(req.params.id)
    res.set({ 'Content-Type': file.mime, 'Content-Disposition': `attachment; filename="document.${file.mime === 'application/pdf' ? 'pdf' : file.mime === 'image/png' ? 'png' : 'jpg'}"`, 'X-Content-Type-Options': 'nosniff' }).send(Buffer.from(file.base64, 'base64'))
  })
  router.patch('/applications/:id', allow('staff', 'admin'), writes, json, async (req, res) => {
    fields(req.body, ['status', 'reviewNote'])
    res.json(await repo.decideApplication(req.params.id, choice(req.body.status, ['approved', 'rejected']), text(req.body.reviewNote, 1000, true), req.auth.user.id))
  })
  router.get('/posts', allow('business', 'staff', 'admin'), async (req, res) => res.json(await repo.posts(req.portalRole === 'business' ? req.auth.user.id : null, offset(req))))
  router.post('/posts', allow('business'), writes, json, async (req, res) => {
    fields(req.body, ['title', 'copy', 'badge', 'discount', 'border', 'premium', 'event', 'discountPercent', 'offer', 'offerTerms'])
    if (typeof req.body.premium !== 'boolean') throw new HttpError(400, 'Invalid premium flag')
    const title = text(req.body.title, 120), copy = text(req.body.copy, 3000)
    const discountPercent = req.body.discountPercent ?? 0
    if (!Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent > 100) throw new HttpError(400, 'Discount must be an integer from 0 to 100')
    let event
    if (req.body.event !== undefined) {
      fields(req.body.event, ['category', 'location', 'province', 'address', 'meetingPoint', 'startsAt', 'endsAt', 'registrationDeadline', 'estimatedCost', 'maxParticipants', 'itinerary', 'plan', 'planLink'])
      event = activityFields({ ...req.body.event, title, description: copy })
    }
    res.status(201).json(await repo.createPost(req.auth.user.id, { title, copy, badge: text(req.body.badge, 60, true), discount: text(req.body.discount, 60, true), border: choice(req.body.border, ['Glow', 'Soft', 'Solid']), premium: req.body.premium, ...(event ? { event } : {}), discountPercent, offer: text(req.body.offer, 200, true), offerTerms: text(req.body.offerTerms, 500, true) }))
  })
  router.patch('/posts/:id', allow('staff', 'admin'), writes, json, async (req, res) => {
    fields(req.body, ['status', 'reviewNote'])
    res.json(await repo.decidePost(req.params.id, choice(req.body.status, ['approved', 'rejected']), text(req.body.reviewNote, 1000, true), req.auth.user.id))
  })
  router.get('/users', allow('admin'), async (req, res) => res.json(await repo.users(offset(req))))
  router.patch('/users/:id/role', allow('admin'), writes, json, async (req, res) => {
    fields(req.body, ['role'])
    res.json(await repo.setRole(req.params.id, choice(req.body.role, ['user', 'staff', 'admin']), req.auth.user.id))
  })
  router.patch('/users/:id/subscription', allow('admin'), writes, json, async (req, res) => {
    fields(req.body, ['plan', 'status'])
    res.json(await repo.subscription(req.params.id, { plan: choice(req.body.plan, ['free', 'plus']), status: choice(req.body.status, ['active', 'paused', 'cancelled']) }, req.auth.user.id))
  })
  router.get('/metrics', allow('business', 'staff', 'admin'), async (req, res) => res.json(await repo.metrics(req.portalRole, req.auth.user.id)))
  router.get('/reports', allow('staff', 'admin'), async (req, res) => { const items = await auth.community.moderationQueue(); const start = offset(req); res.json({ items: items.slice(start, start + 20), total: items.length }) })
  router.patch('/reports/:id', allow('staff', 'admin'), writes, json, async (req, res) => {
    fields(req.body, ['status', 'hideActivity'])
    const status = choice(req.body.status, ['resolved', 'dismissed'])
    if (typeof req.body.hideActivity !== 'boolean' || req.body.hideActivity && status !== 'resolved') throw new HttpError(400, 'Invalid report decision')
    res.json(await auth.community.moderate(req.params.id, req.auth.user.id, status, req.body.hideActivity))
  })
  router.get('/tickets', async (req, res) => res.json(await repo.tickets(['staff', 'admin'].includes(req.portalRole) ? null : req.auth.user.id, offset(req))))
  router.post('/tickets', writes, json, async (req, res) => { fields(req.body, ['subject', 'message']); res.status(201).json(await repo.createTicket(req.auth.user.id, text(req.body.subject, 150), text(req.body.message, 3000))) })
  router.post('/tickets/:id/replies', writes, json, async (req, res) => {
    fields(req.body, ['message', 'status'])
    const staff = ['staff', 'admin'].includes(req.portalRole)
    res.json(await repo.reply(req.params.id, staff ? null : req.auth.user.id, req.auth.user.id, text(req.body.message, 3000), staff ? choice(req.body.status, ['open', 'closed']) : 'open'))
  })
  return router
}
