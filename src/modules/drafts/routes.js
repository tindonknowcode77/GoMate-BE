import express, { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { authenticate } from '../../middlewares/authenticate.js'
import { companionFields } from '../../common/companions.js'
import { HttpError } from '../../common/http-error.js'

const strings = ['name','category','description','date','endDate','startTime','endTime','registrationDeadline','scheduleNote','province','district','ward','address','meetingPoint','maxParticipants','minParticipants','requirements','planLink','costNote','organizerType','hostAvatarUrl']
const others = ['photos','coordinates','companions','reservedSeats','initialFriendIds','itinerary','planAttachment','planFile','financialConfig','participantPreferences','replacePhotos','deadlineHoursBefore','deadlineCustom']
const object = value => value && typeof value === 'object' && !Array.isArray(value)
function validate(state) {
  if (!object(state) || Object.keys(state).some(key => !['step','customCategory','data'].includes(key)) || !Number.isInteger(state.step) || state.step < 1 || state.step > 4 || typeof state.customCategory !== 'boolean' || !object(state.data)) throw new HttpError(400, 'Invalid activity draft')
  const data = state.data
  if (Object.keys(data).some(key => ![...strings, ...others].includes(key)) || strings.some(key => data[key] != null && (typeof data[key] !== 'string' || data[key].length > 4000))) throw new HttpError(400, 'Invalid draft fields')
  if (!Array.isArray(data.photos) || data.photos.length > 6) throw new HttpError(400, 'Invalid draft photos')
  const base64 = (value, max) => typeof value === 'string' && value.length <= Math.ceil(max / 3) * 4 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value) && Buffer.byteLength(value, 'base64') <= max
  for (const photo of data.photos) if (!object(photo) || !base64(photo.base64, 10 * 1024 * 1024)) throw new HttpError(400, 'Mỗi ảnh bản nháp tối đa 10 MB.')
  if (data.planAttachment && (!object(data.planAttachment) || typeof data.planAttachment.name !== 'string' || data.planAttachment.name.length > 120 || !base64(data.planAttachment.base64, 3 * 1024 * 1024))) throw new HttpError(400, 'Invalid draft Excel attachment')
  // Limit structured fields separately from binary/base64 attachments. No draft field is executed or published.
  const plain = { ...data, photos: [], planAttachment: null }
  if (JSON.stringify(plain).length > 250000) throw new HttpError(413, 'Bản nháp có quá nhiều nội dung.')
  for (const key of ['financialConfig','participantPreferences','coordinates','planFile']) if (data[key] != null && !object(data[key])) throw new HttpError(400, 'Invalid draft structure')
  for (const key of ['companions','initialFriendIds','itinerary']) if (data[key] !== undefined && (!Array.isArray(data[key]) || data[key].length > 1000)) throw new HttpError(400, 'Invalid draft list')
  if (data.reservedSeats !== undefined && (!Number.isInteger(data.reservedSeats) || data.reservedSeats < 0 || data.reservedSeats > 999)) throw new HttpError(400, 'Invalid draft capacity')
  if (data.companions) companionFields(data.companions, data.reservedSeats ?? 0)
  if (data.initialFriendIds?.some(id => typeof id !== 'string' || id.length > 80)) throw new HttpError(400, 'Invalid draft friends')
  if (data.coordinates && (!Number.isFinite(data.coordinates.latitude) || Math.abs(data.coordinates.latitude) > 90 || !Number.isFinite(data.coordinates.longitude) || Math.abs(data.coordinates.longitude) > 180)) throw new HttpError(400, 'Invalid draft point')
  if (data.organizerType !== undefined && data.organizerType !== 'personal') throw new HttpError(400, 'Only personal activity drafts are supported')
  for (const key of ['replacePhotos','deadlineCustom']) if (data[key] !== undefined && typeof data[key] !== 'boolean') throw new HttpError(400, 'Invalid draft option')
  if (data.deadlineHoursBefore !== undefined && (!Number.isFinite(data.deadlineHoursBefore) || data.deadlineHoursBefore < 0 || data.deadlineHoursBefore > 8760)) throw new HttpError(400, 'Invalid draft deadline')
  if (data.itinerary?.some(item => !object(item) || Object.values(item).some(value => typeof value !== 'string' || value.length > 4000))) throw new HttpError(400, 'Invalid draft itinerary')
  if (data.financialConfig && Object.entries(data.financialConfig).some(([key, value]) => ['fundingMode','paymentDeadline','treasurerUserId','approvalRule'].includes(key) ? typeof value !== 'string' || value.length > 160 : !Number.isFinite(value) || value < 0 || value > 1000000000)) throw new HttpError(400, 'Invalid draft budget')
  if (data.participantPreferences) {
    for (const [key, value] of Object.entries(data.participantPreferences)) {
      const valid = ['genders','languages','religions'].includes(key) ? Array.isArray(value) && value.length <= 100 && value.every(item => typeof item === 'string' && item.length <= 160)
        : ['minAge','maxAge'].includes(key) ? Number.isInteger(value) && value >= 0 && value <= 120 : ['alcohol','dressCode'].includes(key) && typeof value === 'string' && value.length <= 1000
      if (!valid) throw new HttpError(400, 'Invalid draft preferences')
    }
  }
  return { ...state, data: { ...data, photos: data.photos.map(photo => ({ base64: photo.base64 })) } }
}
export function createDraftRouter(authRepository) {
  const router = Router(), repository = authRepository.drafts
  router.use(authenticate(authRepository), (_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
  router.get('/', async (req, res) => res.json({ draft: await repository.get(req.auth.user.id) }))
  router.put('/', rateLimit({ windowMs: 60000, limit: 10, keyGenerator: req => req.auth.user.id, standardHeaders: 'draft-8', legacyHeaders: false }), express.json({ limit: '88mb' }), async (req, res) => {
    if (!object(req.body) || Object.keys(req.body).some(key => !['state','version'].includes(key)) || !Number.isInteger(req.body.version) || req.body.version < 0) throw new HttpError(400, 'Invalid draft version')
    res.json(await repository.save(req.auth.user.id, validate(req.body.state), req.body.version))
  })
  router.delete('/', express.json({ limit: '1kb' }), async (req, res) => {
    if (!object(req.body) || Object.keys(req.body).some(key => key !== 'version') || !Number.isInteger(req.body.version) || req.body.version < 1) throw new HttpError(400, 'Invalid draft version')
    await repository.remove(req.auth.user.id, req.body.version); res.status(204).end()
  })
  return router
}
