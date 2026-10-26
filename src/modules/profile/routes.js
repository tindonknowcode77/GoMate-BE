import { randomUUID } from 'node:crypto'
import express, { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import sharp from 'sharp'
import multer from 'multer'
import { createAvatarStorage } from './cloudinary.js'
import { HttpError } from '../../common/http-error.js'
import { authenticate } from '../../middlewares/authenticate.js'
import { genders, religions, stringList } from '../../common/preferences.js'

function profile(user) {
  if (!user) throw new HttpError(404, 'Profile not found')
  const missingFields = ['name', 'location', 'bio'].filter(key => !user[key]?.trim())
  if (!user.interests?.length) missingFields.push('interests')
  if (!user.languages?.length) missingFields.push('languages')
  if (!user.birthDate) missingFields.push('birthDate')
  if (!user.gender) missingFields.push('gender')
  const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10)
  const age = user.birthDate ? Number(today.slice(0, 4)) - Number(user.birthDate.slice(0, 4)) - (today.slice(5) < user.birthDate.slice(5) ? 1 : 0) : null
  const basicMissing = missingFields.filter(key => ['name', 'birthDate', 'gender', 'location', 'languages'].includes(key))
  return { age: Number.isFinite(age) ? age : null, basicProfileComplete: basicMissing.length === 0, emailVerified: user.email_verified === true || Boolean(user.google_sub),
    education: user.education ?? '', school: user.school ?? '', companionGoal: user.companionGoal ?? '',
    availableTimes: user.availableTimes ?? [], activityWish: user.activityWish ?? '', contribution: user.contribution ?? '',
    photos: (user.profile_photos ?? []).map(({ id, url }) => ({ id, url })),
    id: user.id, name: user.name, email: user.email,
    username: user.username ?? '', bio: user.bio ?? '', location: user.location ?? '',
    interests: user.interests ?? [],
    languages: user.languages ?? [], gender: user.gender ?? 'undisclosed', religion: user.religion ?? 'undisclosed',
    alcohol: user.alcohol ?? 'undisclosed', birthDate: user.birthDate ?? '',
    profileComplete: missingFields.length === 0, missingFields,
    avatarUrl: user.avatar_url ?? (user.avatar_version ? `/api/profile/${user.id}/avatar?v=${user.avatar_version}` : null),
    coverUrl: user.cover_url ?? null, occupation: user.occupation ?? '', demo: user.demo === true,
  }
}

function fields(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid profile')
  const limits = { name: [2, 100], username: [0, 30], bio: [0, 500], location: [0, 100], occupation: [0, 100], education: [0, 80], school: [0, 120], companionGoal: [0, 120], activityWish: [0, 300], contribution: [0, 300] }
  const result = {}
  for (const [key, value] of Object.entries(body)) {
    if (key === 'availableTimes') { result[key] = stringList(value, key) }
    else if (key === 'languages') { result[key] = stringList(value, key) }
    else if (['gender', 'religion', 'alcohol'].includes(key)) {
      const options = key === 'gender' ? genders : key === 'religion' ? religions : ['yes', 'no', 'undisclosed']
      if (!options.includes(value)) throw new HttpError(400, `Invalid ${key}`)
      result[key] = value
    } else if (key === 'birthDate') {
      if (typeof value !== 'string' || (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(new Date(value).getTime()) || new Date(value).toISOString().slice(0, 10) !== value || new Date(value) > new Date() || value < '1900-01-01'))) throw new HttpError(400, 'Invalid birthDate')
      result[key] = value
    } else if (key === 'interests') {
      if (!Array.isArray(value) || value.length > 12 || value.some(item => typeof item !== 'string' || !item.trim() || item.trim().length > 40)) {
        throw new HttpError(400, 'interests must contain at most 12 strings of 1–40 characters')
      }
      result.interests = [...new Set(value.map(item => item.trim()))]
    } else if (Object.hasOwn(limits, key)) {
      if (typeof value !== 'string') throw new HttpError(400, `${key} must be a string`)
      const normalized = key === 'username' ? value.trim().replace(/^@/, '').toLowerCase() : value.trim()
      const [min, max] = limits[key]
      const labels = { name: 'họ tên', username: 'nickname', bio: 'giới thiệu', location: 'khu vực', occupation: 'nghề nghiệp', education: 'học vấn', school: 'trường học', companionGoal: 'mục tiêu đồng hành', activityWish: 'hoạt động mong muốn', contribution: 'điều bạn có thể đóng góp' }
      if (normalized.length < min) throw new HttpError(400, `Vui lòng nhập ${labels[key]}.`)
      if (normalized.length > max) throw new HttpError(400, `${labels[key]} quá dài. Vui lòng viết ngắn gọn hơn.`)
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
    fileSize: 10 * 1024 * 1024, files: 1, fields: 0, parts: 1,
  } }).single('avatar')
  const parseImage = (req, res, next) => {
    if (!req.is('multipart/form-data')) return express.json({ limit: '14mb' })(req, res, next)
    multipart(req, res, error => {
      if (!error) return next()
      next(new HttpError(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
        error.code === 'LIMIT_FILE_SIZE' ? 'Mỗi ảnh tối đa 10 MB.' : 'Chọn một ảnh đại diện.'))
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
  router.get('/:id', async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new HttpError(404, 'Profile not found')
    if (await repository.community?.blocked(req.auth.user.id, req.params.id)) throw new HttpError(403, 'Không thể xem hồ sơ của tài khoản đã chặn')
    const person = profile(await repository.getProfile(req.params.id))
    const keys = ['id', 'name', 'username', 'bio', 'location', 'interests', 'languages', 'avatarUrl', 'coverUrl', 'occupation', 'demo', 'age', 'education', 'school', 'companionGoal', 'availableTimes', 'activityWish', 'contribution', 'photos']
    res.json({ profile: Object.fromEntries(keys.map(key => [key, person[key]])), reputation: await repository.community?.reputation(req.params.id) })
  })
  router.patch('/me', express.json({ limit: '16kb' }), async (req, res) => {
    try {
      res.json({ profile: profile(await repository.updateProfile(req.auth.user.id, fields(req.body))) })
    } catch (error) {
      if (error.code === 11000) throw new HttpError(409, 'Username already in use')
      throw error
    }
  })
  router.get('/me/reviews', async (req, res) => res.json(await repository.profileReviews(req.auth.user.id)))
  const photoWrites = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false })
  router.put('/me/cover', photoWrites, express.json({ limit: '14mb' }), async (req, res) => {
    const previous = await repository.getProfile(req.auth.user.id)
    if (!previous) throw new HttpError(404, 'Profile not found')
    const value = req.body?.base64
    if (!req.body || Object.keys(req.body).length !== 1 || typeof value !== 'string' || !value.length || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new HttpError(400, 'Provide one base64 image')
    const input = Buffer.from(value, 'base64')
    if (input.length > 10 * 1024 * 1024) throw new HttpError(413, 'Ảnh bìa tối đa 10 MB')
    let image
    try {
      const source = sharp(input, { limitInputPixels: 20000000 }), info = await source.metadata()
      if (!['jpeg', 'png', 'webp'].includes(info.format) || (info.pages ?? 1) > 1) throw new Error('Invalid image')
      image = await source.rotate().resize(1600, 600, { fit: 'cover', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer()
    } catch { throw new HttpError(400, 'Chọn ảnh JPEG/PNG/WebP hợp lệ') }
    const uploaded = await storage.upload(image, req.auth.user.id)
    let updated
    try {
      updated = await repository.saveCover(req.auth.user.id, previous, uploaded)
      if (!updated) throw new HttpError(409, 'Ảnh bìa đã thay đổi. Tải lại và thử lại.')
    } catch (error) { await cleanup(uploaded.publicId); throw error }
    if (previous.cover_public_id) await cleanup(previous.cover_public_id)
    res.json({ profile: profile(updated) })
  })
  router.delete('/me/cover', photoWrites, async (req, res) => {
    const previous = await repository.getProfile(req.auth.user.id)
    if (!previous) throw new HttpError(404, 'Profile not found')
    const updated = await repository.saveCover(req.auth.user.id, previous, null)
    if (!updated) throw new HttpError(409, 'Ảnh bìa đã thay đổi. Tải lại và thử lại.')
    if (previous.cover_public_id) await cleanup(previous.cover_public_id)
    res.json({ profile: profile(updated) })
  })
  router.post('/me/photos', photoWrites, express.json({ limit: '14mb' }), async (req, res) => {
    const previous = await repository.getProfile(req.auth.user.id)
    if (!previous) throw new HttpError(404, 'Profile not found')
    if ((previous.profile_photos?.length ?? 0) >= 6) throw new HttpError(409, 'Tối đa 6 ảnh hồ sơ')
    const value = req.body?.base64
    if (!req.body || Object.keys(req.body).length !== 1 || typeof value !== 'string' || !value.length || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new HttpError(400, 'Provide one base64 image')
    const input = Buffer.from(value, 'base64')
    if (input.length > 10 * 1024 * 1024) throw new HttpError(413, 'Mỗi ảnh hồ sơ tối đa 10 MB')
    let image
    try {
      const source = sharp(input, { limitInputPixels: 20000000 }), info = await source.metadata()
      if (!['jpeg', 'png', 'webp'].includes(info.format) || (info.pages ?? 1) > 1) throw new Error('Invalid image')
      image = await source.rotate().resize(1200, 1600, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer()
    } catch { throw new HttpError(400, 'Chọn ảnh JPEG/PNG/WebP hợp lệ') }
    const uploaded = await storage.upload(image, req.auth.user.id)
    try {
      const updated = await repository.replaceProfilePhotos(req.auth.user.id, previous, [...(previous.profile_photos ?? []), { id: randomUUID(), url: uploaded.url, publicId: uploaded.publicId }])
      if (!updated) throw new HttpError(409, 'Ảnh hồ sơ đã thay đổi. Tải lại và thử lại.')
      res.status(201).json({ profile: profile(updated) })
    } catch (error) { await cleanup(uploaded.publicId); throw error }
  })
  router.patch('/me/photos', photoWrites, express.json({ limit: '16kb' }), async (req, res) => {
    const ids = req.body?.photoIds
    if (!req.body || Object.keys(req.body).length !== 1 || !Array.isArray(ids) || ids.length > 6 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new HttpError(400, 'Provide ordered photoIds')
    const previous = await repository.getProfile(req.auth.user.id)
    if (!previous) throw new HttpError(404, 'Profile not found')
    const existing = previous.profile_photos ?? []
    if (ids.some(id => !existing.some(image => image.id === id))) throw new HttpError(400, 'Photo does not belong to this profile')
    const updated = await repository.replaceProfilePhotos(req.auth.user.id, previous, ids.map(id => existing.find(image => image.id === id)))
    if (!updated) throw new HttpError(409, 'Ảnh hồ sơ đã thay đổi. Tải lại và thử lại.')
    await Promise.all(existing.filter(image => !ids.includes(image.id)).map(image => cleanup(image.publicId)))
    res.json({ profile: profile(updated) })
  })
  router.put('/me/avatar', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false }),
    parseImage, async (req, res) => {
      const value = req.body?.base64
      if (!req.file && (typeof value !== 'string' || !value.length || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))) throw new HttpError(400, 'Select an avatar file or provide a base64 image')
      const input = req.file?.buffer ?? Buffer.from(value, 'base64')
      if (input.length > 10 * 1024 * 1024) throw new HttpError(413, 'Mỗi ảnh tối đa 10 MB.')
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
