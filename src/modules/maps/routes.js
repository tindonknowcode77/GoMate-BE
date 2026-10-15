import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { authenticate } from '../../middlewares/authenticate.js'
import { HttpError } from '../../common/http-error.js'
import { createMapsService, validPoint } from './service.js'

const session = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
function body(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new HttpError(400, 'Invalid map request')
}
export function createMapsRouter(config, authRepository, options = {}) {
  const router = Router(), service = createMapsService(config, options.fetcher)
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
  router.get('/config', (_req, res) => res.json({ provider: config.mapboxAccessToken ? 'mapbox' : 'osm', accessToken: config.mapboxAccessToken || '', searchProvider: config.vietmapApiKey ? 'vietmap' : config.mapboxAccessToken ? 'mapbox' : 'none', placesEnabled: Boolean(config.vietmapApiKey || config.mapboxAccessToken), routesEnabled: Boolean(config.mapboxAccessToken) }))
  router.use(authenticate(authRepository))
  router.use(rateLimit({ windowMs: 60000, limit: 60, keyGenerator: req => req.auth.user.id, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Tra cứu quá nhanh. Vui lòng thử lại sau.' } }))
  router.post('/places/autocomplete', async (req, res) => {
    body(req.body, ['input', 'sessionToken', 'bias'])
    if (typeof req.body.input !== 'string' || req.body.input.trim().length < 2 || req.body.input.length > 160 || !session(req.body.sessionToken) || (req.body.bias !== undefined && !validPoint(req.body.bias))) throw new HttpError(400, 'Invalid place search')
    if (req.body.input.includes(';') || req.body.input.trim().split(/\s+/).length > 20) throw new HttpError(400, 'Invalid address search')
    res.json({ items: await service.autocomplete(req.body.input.trim(), req.body.sessionToken, req.body.bias, req.auth.user.id) })
  })
  router.post('/places/details', async (req, res) => {
    body(req.body, ['id', 'sessionToken'])
    if (typeof req.body.id !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(req.body.id) || !session(req.body.sessionToken)) throw new HttpError(400, 'Invalid place selection')
    res.json({ place: await service.details(req.body.id, req.body.sessionToken, req.auth.user.id) })
  })
  router.post('/routes', rateLimit({ windowMs: 60000, limit: 12, keyGenerator: req => req.auth.user.id, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Đã đạt giới hạn tìm đường. Vui lòng thử lại sau.' } }), async (req, res) => {
    body(req.body, ['origin', 'destination', 'mode'])
    if (!validPoint(req.body.origin) || !validPoint(req.body.destination) || !['DRIVE', 'WALK'].includes(req.body.mode)) throw new HttpError(400, 'Invalid route request')
    res.json({ route: await service.route(req.body.origin, req.body.destination, req.body.mode) })
  })
  return router
}
