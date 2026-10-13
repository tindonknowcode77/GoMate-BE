import express, { Router } from 'express'
import sharp from 'sharp'
import { rateLimit } from 'express-rate-limit'
import { activityCategories, activityFields, publicActivity } from './validation.js'
import { authenticate } from '../../middlewares/authenticate.js'
import { HttpError } from '../../common/http-error.js'

const categories = activityCategories
export function searchOptions(query) {
  const allowed = ['q', 'categories', 'minCost', 'maxCost', 'days', 'fromHour', 'toHour', 'lat', 'lng', 'distanceKm', 'page', 'limit']
  for (const [key, value] of Object.entries(query)) {
    if (!allowed.includes(key) || typeof value !== 'string' || !value.trim()) throw new HttpError(400, `Invalid query parameter: ${key}`)
  }
  const number = (key, min, max, fallback, integer = false) => {
    if (query[key] === undefined) return fallback
    if (!/^\d+(?:\.\d+)?$|^-\d+(?:\.\d+)?$/.test(query[key])) throw new HttpError(400, `Invalid ${key}`)
    const value = Number(query[key])
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new HttpError(400, `Invalid ${key}`)
    return value
  }
  const options = { q: query.q?.trim(), categories: query.categories?.split(',') ?? [],
    minCost: number('minCost', 0, 1000000000), maxCost: number('maxCost', 0, 1000000000),
    lat: number('lat', -90, 90), lng: number('lng', -180, 180), distanceKm: number('distanceKm', 0.1, 500),
    page: number('page', 1, 500, 1, true), limit: number('limit', 1, 50, 20, true),
    days: query.days?.split(',').map(Number) ?? [],
    fromHour: number('fromHour', 0, 23, 0, true), toHour: number('toHour', 1, 24, 24, true),
  }
  if (options.q?.length > 100 || options.categories.some(value => !categories.includes(value)) || options.categories.length > 7) throw new HttpError(400, 'Invalid search or categories')
  if (options.days.length > 7 || options.days.some(value => !Number.isInteger(value) || value < 1 || value > 7)) throw new HttpError(400, 'days must use ISO weekdays 1–7')
  if (options.minCost > options.maxCost || options.fromHour >= options.toHour) throw new HttpError(400, 'Invalid cost or hour range')
  if ((options.lat === undefined) !== (options.lng === undefined) || (options.distanceKm !== undefined && options.lat === undefined)) throw new HttpError(400, 'Distance requires lat and lng')
  return options
}

export function createActivityRouter(repository, authRepository, coverStorage) {
  const router = Router()
  router.use(authenticate(authRepository))
  router.get('/', async (req, res) => {
    res.json(await repository.search(searchOptions(req.query), req.auth.user.id))
  })
  router.get('/mine', async (req, res) => {
    if (Object.keys(req.query).some(key => !['page', 'limit'].includes(key))) throw new HttpError(400, 'Only page and limit are supported')
    const { page, limit } = searchOptions(req.query)
    const result = await repository.owned(req.auth.user.id, page, limit)
    res.json({ ...result, items: result.items.map(publicActivity) })
  })
  async function find(id, owner) {
    const row = await repository.get(id)
    if (!row) throw new HttpError(404, 'Activity not found')
    if (owner && row.hostId !== owner) throw new HttpError(403, 'Only the host can change this activity')
    return row
  }
  router.get('/:id', async (req, res) => {
    const row = await find(req.params.id)
    if (row.status !== 'published' && row.hostId !== req.auth.user.id) throw new HttpError(404, 'Activity not found')
    res.json({ activity: publicActivity(row) })
  })
  const cleanup = async id => { try { await coverStorage.remove(id) } catch { console.warn('Activity cover cleanup failed') } }
  async function cover(base64, owner) {
    if (base64 === undefined) return null
    if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new HttpError(400, 'Invalid cover image')
    const buffer = Buffer.from(base64, 'base64')
    if (buffer.length > 2 * 1024 * 1024) throw new HttpError(413, 'Cover must not exceed 2 MB')
    let image
    try {
      const source = sharp(buffer, { limitInputPixels: 20000000 })
      const info = await source.metadata()
      if (!['jpeg', 'png', 'webp'].includes(info.format) || (info.pages ?? 1) !== 1) throw new Error('Invalid image')
      image = await source.rotate().resize(1200, 900, { fit: 'cover', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer()
    } catch { throw new HttpError(400, 'Select a valid JPEG, PNG or WebP cover') }
    return coverStorage.upload(image, owner)
  }
  const writes = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false })
  router.post('/:id/join-requests', writes, express.json({ limit: '16kb' }), async (req, res) => {
    if (req.body !== undefined && (!req.body || Array.isArray(req.body) || typeof req.body !== 'object' || Object.keys(req.body).length)) throw new HttpError(400, 'Join request body must be empty')
    const activity = await find(req.params.id)
    if (activity.hostId === req.auth.user.id) throw new HttpError(403, 'Host cannot request to join their own activity')
    const request = await repository.submitJoinRequest(activity.id, req.auth.user)
    if (!request) throw new HttpError(409, 'Activity is unavailable, full, request limit reached, or you already have a pending/approved request')
    res.status(201).json({ request })
  })
  router.delete('/:id/join-requests/me', writes, async (req, res) => {
    const activity = await find(req.params.id)
    const existing = activity.joinRequests?.find(item => item.userId === req.auth.user.id)
    if (!existing) throw new HttpError(404, 'Join request not found')
    const request = await repository.changeJoinRequest(activity.id, { userId: req.auth.user.id, status: 'cancelled' })
    if (!request) throw new HttpError(409, 'Only pending requests for upcoming published activities can be cancelled')
    res.status(204).end()
  })
  router.get('/:id/join-requests', async (req, res) => {
    const activity = await find(req.params.id, req.auth.user.id)
    const { status, ...pagination } = req.query
    if (status !== undefined && !['pending', 'approved', 'rejected', 'cancelled'].includes(status)) throw new HttpError(400, 'Invalid request status')
    if (Object.keys(pagination).some(key => !['page', 'limit'].includes(key))) throw new HttpError(400, 'Only status, page and limit are supported')
    const { page, limit } = searchOptions(pagination)
    const items = (activity.joinRequests ?? []).filter(item => !status || item.status === status)
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    res.json({ items: items.slice((page - 1) * limit, page * limit), total: items.length, page, limit, hasMore: page * limit < items.length })
  })
  router.patch('/:id/join-requests/:requestId', writes, express.json({ limit: '16kb' }), async (req, res) => {
    if (!req.body || Array.isArray(req.body) || Object.keys(req.body).length !== 1 || !['approved', 'rejected'].includes(req.body.status)) throw new HttpError(400, 'Provide only status: approved or rejected')
    const activity = await find(req.params.id, req.auth.user.id)
    if (!activity.joinRequests?.some(item => item.id === req.params.requestId)) throw new HttpError(404, 'Join request not found')
    const request = await repository.changeJoinRequest(activity.id, { hostId: req.auth.user.id, requestId: req.params.requestId, status: req.body.status })
    if (!request) throw new HttpError(409, 'Request is no longer pending, activity unavailable, or capacity reached')
    res.json({ request })
  })
  router.post('/', writes, express.json({ limit: '3mb' }), async (req, res) => {
    const fields = activityFields(req.body)
    const image = await cover(req.body.coverBase64, req.auth.user.id)
    try {
      const row = await repository.create({ ...fields, ...(image ? { imageUrl: image.url, imagePublicId: image.publicId } : {}) }, req.auth.user)
      res.status(201).json({ activity: publicActivity(row) })
    } catch (error) { if (image) await cleanup(image.publicId); throw error }
  })
  router.patch('/:id', writes, express.json({ limit: '3mb' }), async (req, res) => {
    const previous = await find(req.params.id, req.auth.user.id)
    if (previous.startsAt <= new Date()) throw new HttpError(409, 'Started activities cannot be edited')
    const fields = activityFields(req.body, previous)
    const image = await cover(req.body.coverBase64, req.auth.user.id)
    let row
    try {
      row = await repository.update(previous, { ...fields, ...(image ? { imageUrl: image.url, imagePublicId: image.publicId } : {}) })
      if (!row) throw new HttpError(409, 'Activity changed. Reload and try again.')
    } catch (error) { if (image) await cleanup(image.publicId); throw error }
    if (image && previous.imagePublicId) await cleanup(previous.imagePublicId)
    res.json({ activity: publicActivity(row) })
  })
  router.delete('/:id', writes, async (req, res) => {
    const previous = await find(req.params.id, req.auth.user.id)
    if (!await repository.remove(previous)) throw new HttpError(409, 'Activity changed. Reload and try again.')
    if (previous.imagePublicId) await cleanup(previous.imagePublicId)
    res.status(204).end()
  })
  return router
}
