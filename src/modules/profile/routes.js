import express, { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import sharp from 'sharp'
import multer from 'multer'
import { createAvatarStorage } from './cloudinary.js'
import { HttpError } from '../../common/http-error.js'
import { authenticate } from '../../middlewares/authenticate.js'

function profile(user) {
  if (!user) throw new HttpError(404, 'Profile not found')
  return { id: user.id, name: user.name, email: user.email,
    username: user.username ?? '', bio: user.bio ?? '', location: user.location ?? '',
    interests: user.interests ?? [],
    avatarUrl: user.avatar_url ?? (user.avatar_version ? `/api/profile/${user.id}/avatar?v=${user.avatar_version}` : null),
  }
}

function fields(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid profile')
  const limits = { name: [2, 100], username: [0, 30], bio: [0, 500], location: [0, 100] }
  const result = {}
  for (const [key, value] of Object.entries(body)) {
    if (key === 'interests') {
      if (!Array.isArray(value) || value.length > 12 || value.some(item => typeof item !== 'string' || !item.trim() || item.trim().length > 40)) {
        throw new HttpError(400, 'interests must contain at most 12 strings of 1–40 characters')
      }
      result.interests = [...new Set(value.map(item => item.trim()))]
    } else if (Object.hasOwn(limits, key)) {
      if (typeof value !== 'string') throw new HttpError(400, `${key} must be a string`)
      const normalized = key === 'username' ? value.trim().replace(/^@/, '').toLowerCase() : value.trim()
      const [min, max] = limits[key]
      if (normalized.length < min || normalized.length > max) throw new HttpError(400, `${key} must be ${min}–${max} characters`)
      if (key === 'username' && normalized && !/^[a-z0-9_]{3,30}$/.test(normalized)) throw new HttpError(400, 'username must be 3–30 letters, numbers or underscores')
      result[key] = normalized
    } else throw new HttpError(400, `Unsupported profile field: ${key}`)
  }
  if (!Object.keys(result).length) throw new HttpError(400, 'No profile fields provided')
  return result
}

export function createProfileRouter(repository, config, storage = createAvatarStorage(config)) {
  const router = Router()
  const multipart = multer({ storage: multer.memoryStorage(), limits: {
    fileSize: 2 * 1024 * 1024, files: 1, fields: 0, parts: 1,
  } }).single('avatar')
  const parseImage = (req, res, next) => {
    if (!req.is('multipart/form-data')) return express.json({ limit: '3mb' })(req, res, next)
    multipart(req, res, error => {
      if (!error) return next()
      next(new HttpError(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
        error.code === 'LIMIT_FILE_SIZE' ? 'Avatar must not exceed 2 MB' : 'Send one image file in the avatar field'))
    })
  }
  const cleanup = async publicId => {
    try { await storage.remove(publicId) }
    catch { console.warn('Cloudinary avatar cleanup failed; retry cleanup may be required.') }
  }
  // Avatars are public profile images. Only the account owner can replace one.
  router.get('/:id/avatar', async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new HttpError(404, 'Avatar not found')
    const user = await repository.getProfile(req.params.id)
    if (user?.avatar_url) return res.set('Cache-Control', 'no-cache').redirect(user.avatar_url)
    const data = await repository.getAvatar(req.params.id)
    if (!data) throw new HttpError(404, 'Avatar not found')
    res.set('Cross-Origin-Resource-Policy', 'cross-origin')
    res.set('Cache-Control', 'no-cache')
    res.type('image/webp').send(data)
  })
  router.use(authenticate(repository))
  router.get('/me', async (req, res) => res.json({ profile: profile(await repository.getProfile(req.auth.user.id)) }))
  router.patch('/me', express.json({ limit: '16kb' }), async (req, res) => {
    try {
      res.json({ profile: profile(await repository.updateProfile(req.auth.user.id, fields(req.body))) })
    } catch (error) {
      if (error.code === 11000) throw new HttpError(409, 'Username already in use')
      throw error
    }
  })
  router.put('/me/avatar', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false }),
    parseImage, async (req, res) => {
      const value = req.body?.base64
      if (!req.file && (typeof value !== 'string' || !value.length || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))) throw new HttpError(400, 'Select an avatar file or provide a base64 image')
      const input = req.file?.buffer ?? Buffer.from(value, 'base64')
      if (input.length > 2 * 1024 * 1024) throw new HttpError(413, 'Avatar must not exceed 2 MB')
      let image
      try {
        const source = sharp(input, { limitInputPixels: 20000000 })
        const metadata = await source.metadata()
        if (!['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.pages ?? 1) > 1) throw new Error('Unsupported image')
        image = await source.rotate().resize(512, 512, { fit: 'cover', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer()
      } catch { throw new HttpError(400, 'Upload a valid, non-animated JPEG, PNG or WebP image (max 20 megapixels)') }
      const uploaded = await storage.upload(image, req.auth.user.id)
      let previous
      try {
        previous = await repository.saveAvatar(req.auth.user.id, uploaded)
        if (!previous) throw new HttpError(404, 'Profile not found')
      } catch (error) {
        await cleanup(uploaded.publicId)
        throw error
      }
      if (previous.avatar_public_id) await cleanup(previous.avatar_public_id)
      res.json({ profile: profile(await repository.getProfile(req.auth.user.id)) })
    })
  return router
}
