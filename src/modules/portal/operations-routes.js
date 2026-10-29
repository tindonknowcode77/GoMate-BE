import express, { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { HttpError } from '../../common/http-error.js'
import { fields, text, email, phone, version, locationFields } from './validation.js'

export function createBusinessOperationsRouter(auth) {
  const router = Router(), repo = auth.portal.operations
  const allow = (...roles) => (req, _res, next) => { if (!roles.includes(req.portalRole)) throw new HttpError(403, 'Insufficient business permissions'); next() }
  const writes = rateLimit({ windowMs: 60000, limit: 60, keyGenerator: req => req.auth.user.id, standardHeaders: 'draft-8', legacyHeaders: false })
  const json = express.json({ limit: '128kb' })
  router.get('/wallet', allow('business'), async (req, res) => { res.set('Cache-Control', 'no-store'); res.json(await repo.wallet(req.auth.user.id)) })
  const offset = req => { const page = Number(req.query.page ?? 1); if (Object.keys(req.query).some(key => key !== 'page') || !Number.isInteger(page) || page < 1 || page > 500) throw new HttpError(400, 'Invalid page'); return (page - 1) * 20 }
  router.get('/locations', allow('business', 'business-staff'), async (req, res) => res.json(await repo.listLocations(req.auth.user.id, offset(req))))
  router.post('/locations', allow('business'), writes, json, async (req, res) => res.status(201).json(await repo.saveLocation(req.auth.user.id, null, null, locationFields(req.body))))
  router.put('/locations/:id', allow('business'), writes, json, async (req, res) => res.json(await repo.saveLocation(req.auth.user.id, req.params.id, version(req.body?.version), locationFields(req.body))))
  router.delete('/locations/:id', allow('business'), writes, json, async (req, res) => { fields(req.body, ['version']); res.json(await repo.deleteLocation(req.auth.user.id, req.params.id, version(req.body.version))) })
  router.get('/groups', allow('business', 'business-staff'), async (req, res) => res.json(await repo.listGroups(req.auth.user.id, offset(req))))
  router.get('/groups/:id', allow('business', 'business-staff'), async (req, res) => res.json(await repo.getGroup(req.auth.user.id, req.params.id)))
  router.put('/groups/:id/plan', allow('business', 'business-staff'), writes, json, async (req, res) => { fields(req.body, ['version', 'itinerary']); res.json(await repo.savePlan(req.auth.user.id, req.params.id, version(req.body.version), req.body.itinerary)) })
  router.patch('/groups/:id/deposits/:userId', allow('business', 'business-staff'), writes, json, async (req, res) => {
    fields(req.body, ['version', 'status']); if (!['paid', 'pending'].includes(req.body.status)) throw new HttpError(400, 'Invalid deposit status')
    res.json(await repo.recordDeposit(req.auth.user.id, req.params.id, version(req.body.version), req.params.userId, req.body.status))
  })
  router.patch('/groups/:id/requests/:requestId', allow('business', 'business-staff'), writes, json, async (req, res) => {
    fields(req.body, ['version', 'status']); if (!['approved', 'rejected'].includes(req.body.status)) throw new HttpError(400, 'Invalid request status')
    res.json(await repo.decideMember(req.auth.user.id, req.params.id, version(req.body.version), req.params.requestId, req.body.status))
  })
  router.post('/groups/:id/offers', allow('business', 'business-staff'), writes, json, async (req, res) => {
    fields(req.body, ['version', 'clientId', 'title', 'body', 'expiresAt'])
    const expiresAt = text(req.body.expiresAt, 50, true)
    if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || new Date(expiresAt) <= new Date())) throw new HttpError(400, 'Offer expiry must be in the future')
    res.json(await repo.offer(req.auth.user.id, req.params.id, version(req.body.version), { clientId: text(req.body.clientId, 100), title: text(req.body.title, 120), body: text(req.body.body, 1000), expiresAt }))
  })
  router.put('/groups/:id/offers/:offerId', allow('business', 'business-staff'), writes, json, async (req, res) => {
    fields(req.body, ['version','title','body','expiresAt'])
    const expiresAt=text(req.body.expiresAt,50,true)
    if(expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || new Date(expiresAt)<=new Date())) throw new HttpError(400,'Offer expiry must be in the future')
    res.json(await repo.editOffer(req.auth.user.id,req.params.id,version(req.body.version),req.params.offerId,{title:text(req.body.title,120),body:text(req.body.body,1000),expiresAt}))
  })
  router.post('/groups/:id/actions/:action', allow('business', 'business-staff'), writes, json, async (req, res) => {
    fields(req.body, ['version']); if (!['confirm-schedule', 'start', 'complete'].includes(req.params.action)) throw new HttpError(400, 'Invalid group action')
    res.json(await repo.action(req.auth.user.id, req.params.id, version(req.body.version), req.params.action))
  })
  router.patch('/groups/:id/attendance/:userId', allow('business', 'business-staff'), writes, json, async (req, res) => {
    fields(req.body, ['version', 'status']); if (!['unmarked', 'present', 'late', 'absent'].includes(req.body.status)) throw new HttpError(400, 'Invalid attendance')
    res.json(await repo.attendance(req.auth.user.id, req.params.id, version(req.body.version), req.params.userId, req.body.status))
  })
  const staffFields = body => {
    fields(body, ['name', 'email', 'phone', 'title', 'groupIds', 'version'])
    if (!Array.isArray(body.groupIds) || !body.groupIds.length || body.groupIds.length > 50 || new Set(body.groupIds).size !== body.groupIds.length || body.groupIds.some(id => typeof id !== 'string' || !/^[\da-f-]{36}$/i.test(id))) throw new HttpError(400, 'Select 1–50 valid groups')
    return { name: text(body.name, 120), email: email(body.email), phone: phone(body.phone), title: text(body.title, 80), groupIds: body.groupIds }
  }
  router.get('/staff', allow('business'), async (req, res) => res.json(await repo.listStaff(req.auth.user.id, offset(req))))
  router.post('/staff', allow('business'), writes, json, async (req, res) => res.status(201).json(await repo.saveStaff(req.auth.user.id, null, null, staffFields(req.body))))
  router.put('/staff/:id', allow('business'), writes, json, async (req, res) => res.json(await repo.saveStaff(req.auth.user.id, req.params.id, version(req.body?.version), staffFields(req.body))))
  router.delete('/staff/:id', allow('business'), writes, json, async (req, res) => { fields(req.body, ['version']); res.json(await repo.removeStaff(req.auth.user.id, req.params.id, version(req.body.version))) })
  router.get('/staff-invitations', async (req, res) => res.json(await repo.incomingStaff(req.auth.user.id)))
  router.patch('/staff-invitations/:id', writes, json, async (req, res) => {
    fields(req.body, ['version', 'status']); if (!['accepted', 'declined'].includes(req.body.status)) throw new HttpError(400, 'Invalid staff consent')
    res.json(await repo.acceptStaff(req.auth.user.id, req.params.id, version(req.body.version), req.body.status === 'accepted'))
  })
  router.get('/staff-requests', allow('admin'), async (req, res) => res.json(await repo.listStaff(null, offset(req), true)))
  router.patch('/staff-requests/:id', allow('admin'), writes, json, async (req, res) => {
    fields(req.body, ['version', 'status', 'reviewNote']); if (!['approved', 'rejected'].includes(req.body.status)) throw new HttpError(400, 'Invalid staff review')
    const note = text(req.body.reviewNote, 1000, req.body.status === 'approved')
    res.json(await repo.decideStaff(req.auth.user.id, req.params.id, version(req.body.version), req.body.status, note))
  })
  return router
}
