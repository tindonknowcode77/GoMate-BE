import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { HttpError } from '../../common/http-error.js'
import { authenticate } from '../../middlewares/authenticate.js'
import { credentials } from './validation.js'
import { dummyPasswordHash, hashPassword, verifyPassword } from './password.js'
import { hashToken, newToken, publicUser } from './token.js'
import { createGoogleVerifier } from './google.js'
import { randomInt } from 'node:crypto'
import { createVerificationMailer } from './email.js'

export function createAuthRouter(repository, config, verifyGoogle = createGoogleVerifier(config.googleClientId), mailer = createVerificationMailer(config)) {
  const router = Router()
  const protect = authenticate(repository)
  const limitOptions = {
    windowMs: 15 * 60 * 1000,
    standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Too many attempts. Try again later.' },
  }
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store')
    next()
  })

  router.post('/register', rateLimit({ ...limitOptions, limit: 5 }), async (req, res) => {
    const { email, password, name } = credentials(req.body, true)
    mailer.assertConfigured()
    const passwordHash = await hashPassword(password)
    try {
      const user = await repository.createUser({ email, name, passwordHash })
      await sendVerification(email)
      res.status(201).json({ user: publicUser(user), verificationRequired: true, message: 'Check your email for the verification code.' })
    } catch (error) {
      if (error.code === 11000) throw new HttpError(409, 'Email already registered')
      throw error
    }
  })

  function readEmail(body) {
    return credentials({ email: body?.email, password: 'validation-only' }).email
  }

  async function sendVerification(email) {
    const code = String(randomInt(0, 1000000)).padStart(6, '0')
    const hash = await hashPassword(code)
    const user = await repository.reserveVerification(email, hash)
    if (!user) return
    try { await mailer.sendCode(email, code) } catch (error) {
      await repository.cancelVerification(user.id, hash)
      throw error
    }
  }

  router.post('/resend-verification', rateLimit({ ...limitOptions, limit: 5 }), async (req, res) => {
    const email = readEmail(req.body)
    mailer.assertConfigured()
    await sendVerification(email)
    res.json({ message: 'If the account needs verification, a code will be sent. Wait 60 seconds before requesting another.' })
  })

  router.post('/verify-email', rateLimit({ ...limitOptions, limit: 20 }), async (req, res) => {
    const email = readEmail(req.body)
    const code = req.body?.code
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new HttpError(400, 'A 6-digit verification code is required')
    if (!await repository.verifyEmail(email, code)) throw new HttpError(400, 'Invalid or expired code. Request a new code if needed.')
    res.json({ message: 'Email verified. You can now log in.' })
  })

  function readRememberMe(body) {
    if (body?.rememberMe !== undefined && typeof body.rememberMe !== 'boolean') {
      throw new HttpError(400, 'rememberMe must be a boolean')
    }
    return body?.rememberMe === true
  }

  async function issueSession(user, res, rememberMe) {
    const accessToken = newToken()
    const expiresIn = (rememberMe ? config.rememberSessionTtlHours : config.sessionTtlHours) * 60 * 60
    const expiresAt = new Date(Date.now() + expiresIn * 1000)
    await repository.createSession({
      tokenHash: hashToken(accessToken), userId: user.id,
      expiresAt,
    })
    res.json({ accessToken, tokenType: 'Bearer', expiresIn, expiresAt: expiresAt.toISOString(), user: publicUser(user) })
  }

  router.post('/login', rateLimit({ ...limitOptions, limit: 20 }), async (req, res) => {
    const rememberMe = readRememberMe(req.body)
    const { email, password } = credentials(req.body)
    const user = await repository.findUserByEmail(email)
    const valid = await verifyPassword(password, user?.password_hash ?? dummyPasswordHash)
    if (!user?.password_hash || !valid) throw new HttpError(401, 'Invalid email or password')
    if (user.email_verified !== true) throw new HttpError(403, 'Verify your email before logging in')
    await issueSession(user, res, rememberMe)
  })

  router.post('/google', rateLimit({ ...limitOptions, limit: 20 }), async (req, res) => {
    const rememberMe = readRememberMe(req.body)
    const idToken = req.body?.idToken
    if (typeof idToken !== 'string' || !idToken.trim() || idToken.length > 12000) {
      throw new HttpError(400, 'Google idToken required')
    }
    const identity = await verifyGoogle(idToken)
    let user
    try {
      user = await repository.findOrCreateGoogleUser(identity)
    } catch (error) {
      if (error.code === 11000) throw new HttpError(409, 'Email already registered. Sign in using your existing method.')
      throw error
    }
    await issueSession(user, res, rememberMe)
  })

  router.get('/me', protect, (req, res) => res.json({
    user: req.auth.user,
    expiresAt: req.auth.expiresAt.toISOString(),
    expiresIn: Math.max(0, Math.floor((req.auth.expiresAt.getTime() - Date.now()) / 1000)),
  }))
  router.post('/logout', protect, async (req, res) => {
    await repository.deleteSession(req.auth.tokenHash)
    res.status(204).end()
  })
  return router
}
