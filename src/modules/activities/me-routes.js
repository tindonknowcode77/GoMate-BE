import { Router } from 'express'
import { authenticate } from '../../middlewares/authenticate.js'
import { HttpError } from '../../common/http-error.js'
import { searchOptions } from './routes.js'

export function createMyActivityRouter(repository, authRepository) {
  const router = Router()
  router.use(authenticate(authRepository))
  for (const [path, requests] of [['/activities', false], ['/join-requests', true]]) {
    router.get(path, async (req, res) => {
      const allowed = requests ? ['page', 'limit', 'status'] : ['page', 'limit']
      if (Object.keys(req.query).some(key => !allowed.includes(key))) throw new HttpError(400, 'Unsupported query parameter')
      const { status, ...pagination } = req.query
      if (status !== undefined && !['pending', 'approved', 'rejected', 'cancelled', 'left', 'removed'].includes(status)) throw new HttpError(400, 'Invalid request status')
      const { page, limit } = searchOptions(pagination)
      res.json(await repository.participating(req.auth.user.id, { page, limit, status }, requests))
    })
  }
  return router
}
