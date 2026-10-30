import express, { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { activityCategories } from './validation.js'
import { matchFilters } from '../../common/match-filters.js'
import { authenticate } from '../../middlewares/authenticate.js'
import { HttpError } from '../../common/http-error.js'
import { searchOptions } from './routes.js'

export function createMyActivityRouter(repository, authRepository) {
  const router = Router()
  router.use(authenticate(authRepository))
  router.get('/activity-counts', async (req, res) => res.json(await repository.counts(req.auth.user.id)))
  router.get('/match-preferences', async (req, res) => {
    const user = await authRepository.getProfile(req.auth.user.id)
    res.json({ filters: user.match_filters ?? null, favoriteIds: user.favorite_activity_ids ?? [] })
  })
  router.put('/match-preferences', express.json({ limit: '16kb' }), async (req, res) => {
    const filters = matchFilters(req.body)
    await authRepository.saveMatchFilters(req.auth.user.id, filters)
    res.json({ filters })
  })
  router.post('/match-feedback', rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }), express.json({ limit: '1kb' }), async (req, res) => {
    const { activityId, outcome } = req.body ?? {}
    if (!['skip', 'interested', 'dislike', 'favorite'].includes(outcome) || typeof activityId !== 'string') throw new HttpError(400, 'Invalid Match feedback')
    const activity = await repository.get(activityId)
    if (!activity || !activityCategories.includes(activity.category)) throw new HttpError(404, 'Activity not found')
    await authRepository.recordMatchSignal(req.auth.user.id, activity.category, { skip: -1, interested: 2, dislike: -4, favorite: 2 }[outcome])
    res.status(204).end()
  })
  router.get('/favorites', async (req, res) => {
    if (Object.keys(req.query).some(key => !['page', 'limit'].includes(key))) throw new HttpError(400, 'Unsupported query parameter')
    const { page, limit } = searchOptions(req.query)
    const user = await authRepository.getProfile(req.auth.user.id)
    res.json(await repository.favorites(user.favorite_activity_ids ?? [], page, limit, req.auth.user.id))
  })
  for (const method of ['put', 'delete']) router[method]('/favorites/:id', async (req, res) => {
    const saved = method === 'put'
    if (saved && !await repository.get(req.params.id)) throw new HttpError(404, 'Activity not found')
    const result = await authRepository.setFavorite(req.auth.user.id, req.params.id, saved)
    if (!result.matchedCount) throw new HttpError(409, 'Danh sách yêu thích tối đa 500 hoạt động')
    res.status(204).end()
  })
  for (const [path, requests] of [['/activities', false], ['/join-requests', true]]) {
    router.get(path, async (req, res) => {
      const allowed = requests ? ['page', 'limit', 'status'] : ['page', 'limit']
      if (Object.keys(req.query).some(key => !allowed.includes(key))) throw new HttpError(400, 'Unsupported query parameter')
      const { status, ...pagination } = req.query
      if (status !== undefined && !['pending', 'approved', 'rejected', 'cancelled', 'left', 'removed', 'closed'].includes(status)) throw new HttpError(400, 'Invalid request status')
      const { page, limit } = searchOptions(pagination)
      res.json(await repository.participating(req.auth.user.id, { page, limit, status }, requests))
    })
  }
  return router
}
