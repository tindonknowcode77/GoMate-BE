import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { fileURLToPath } from 'node:url'
import { extname, join } from 'node:path'
import { readConfig } from './config/env.js'
import { HttpError } from './common/http-error.js'
import { createAuthRouter } from './modules/auth/routes.js'
import { createProfileRouter } from './modules/profile/routes.js'

const defaultFrontendDir = fileURLToPath(new URL('../../GoMate-FE/dist/', import.meta.url))

export function createApp(config = readConfig(), { authRepository, verifyGoogle, verificationMailer, avatarStorage, frontendDir = defaultFrontendDir } = {}) {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', config.trustProxyHops)
  app.use(helmet({
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    contentSecurityPolicy: { directives: {
      'upgrade-insecure-requests': null,
      'script-src': ["'self'", 'https://accounts.google.com/gsi/client'],
      'frame-src': ["'self'", 'https://accounts.google.com/gsi/'],
      'connect-src': ["'self'", 'https://accounts.google.com/gsi/'],
      'img-src': ["'self'", 'data:', 'blob:', 'https://res.cloudinary.com'],
      'style-src': ["'self'", "'unsafe-inline'", 'https://accounts.google.com/gsi/style'],
    } },
  }))
  app.use(cors({ origin: config.corsOrigin }))
  if (authRepository) app.use('/api/profile', createProfileRouter(authRepository, config, avatarStorage))
  app.use(express.json({ limit: '16kb' }))

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'gomate-be' })
  })

  if (authRepository) {
    app.use('/api/auth', createAuthRouter(authRepository, config, verifyGoogle, verificationMailer))
  }

  // Unknown API endpoints must never fall through to the React application.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' })
  })

  app.use(express.static(frontendDir, { index: false }))
  app.get('/{*path}', (req, res, next) => {
    if (extname(req.path) || !req.accepts('html')) return next()
    res.sendFile(join(frontendDir, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } }, error => {
      if (error) next(error)
    })
  })

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' })
  })

  app.use((err, _req, res, _next) => {
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600
      ? err.status : 500
    if (status >= 500) console.error('Request failed:', err.code ?? err.name)
    if (status === 401) res.set('WWW-Authenticate', 'Bearer')
    res.status(status).json({ ...(err instanceof HttpError && err.code ? { code: err.code } : {}), error: err instanceof HttpError ? err.message
      : status >= 500 ? 'Internal server error' : 'Invalid request' })
  })
  return app
}
