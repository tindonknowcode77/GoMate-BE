import { HttpError } from '../common/http-error.js'
import { hashToken, publicUser } from '../modules/auth/token.js'

export function authenticate(repository) {
  return async (req, res, next) => {
    res.set('Cache-Control', 'no-store')
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(req.get('authorization') ?? '')
    if (!match) throw new HttpError(401, 'Authentication required', 'AUTH_REQUIRED')
    const tokenHash = hashToken(match[1])
    const session = await repository.findSession(tokenHash)
    if (!session) throw new HttpError(401, 'Invalid or expired token', 'SESSION_INVALID_OR_EXPIRED')
    req.auth = { user: publicUser(session.user), tokenHash, expiresAt: session.expiresAt }
    next()
  }
}
