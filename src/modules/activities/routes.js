import { Router } from 'express'
import { authenticate } from '../../middlewares/authenticate.js'
import { HttpError } from '../../common/http-error.js'

const categories = ['Ăn uống', 'Thể thao', 'Du lịch', 'Giải trí', 'Học tập', 'Gaming', 'Khác']
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

export function createActivityRouter(repository, authRepository) {
  const router = Router()
  router.use(authenticate(authRepository))
  router.get('/', async (req, res) => {
    res.json(await repository.search(searchOptions(req.query), req.auth.user.id))
  })
  return router
}
