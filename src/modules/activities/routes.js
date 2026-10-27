import express, { Router } from 'express'
import { activityReadiness } from '../../common/activity-readiness.js'
import sharp from 'sharp'
import { rateLimit } from 'express-rate-limit'
import { activityCategories, activityFields, publicActivity } from './validation.js'
import { authenticate } from '../../middlewares/authenticate.js'
import { HttpError } from '../../common/http-error.js'
import { planKeys, planningFields } from '../../common/activity-plan.js'
import { companionFields } from '../../common/companions.js'
import { randomUUID } from 'node:crypto'
import { canParticipate, genders, religions } from '../../common/preferences.js'

const categories = activityCategories
export function searchOptions(query) {
  const allowed = ['minAge', 'maxAge', 'organizerType', 'sort', 'q', 'categories', 'minCost', 'maxCost', 'days', 'fromHour', 'toHour', 'fromTime', 'toTime', 'dateFrom', 'dateTo', 'minParticipants', 'maxParticipants', 'gender', 'language', 'religion', 'alcohol', 'dressCode', 'lat', 'lng', 'distanceKm', 'page', 'limit']
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
  if (query.organizerType !== undefined && !['personal', 'business'].includes(query.organizerType)) throw new HttpError(400, 'Invalid organizerType')
  if (query.sort !== undefined && !['recommended', 'nearest', 'soonest'].includes(query.sort)) throw new HttpError(400, 'Invalid sort')
  const options = { organizerType: query.organizerType, sort: query.sort, q: query.q?.trim(), categories: query.categories?.split(',') ?? [],
    minCost: number('minCost', 0, 1000000000), maxCost: number('maxCost', 0, 1000000000),
    lat: number('lat', -90, 90), lng: number('lng', -180, 180), distanceKm: number('distanceKm', 0.1, 500),
    page: number('page', 1, 500, 1, true), limit: number('limit', 1, 50, 20, true),
    days: query.days?.split(',').map(Number) ?? [],
    fromHour: number('fromHour', 0, 23, 0, true), toHour: number('toHour', 1, 24, 24, true),
  }
  if (options.q?.length > 100 || options.categories.some(value => !categories.includes(value)) || options.categories.length > categories.length) throw new HttpError(400, 'Invalid search or categories')
  if (options.days.length > 7 || options.days.some(value => !Number.isInteger(value) || value < 1 || value > 7)) throw new HttpError(400, 'days must use ISO weekdays 1–7')
  if (options.minCost > options.maxCost || options.fromHour >= options.toHour) throw new HttpError(400, 'Invalid cost or hour range')
  if ((options.lat === undefined) !== (options.lng === undefined) || (options.distanceKm !== undefined && options.lat === undefined)) throw new HttpError(400, 'Distance requires lat and lng')
  if (options.sort === 'nearest' && options.lat === undefined) throw new HttpError(400, 'Nearest sort requires lat and lng')
  for (const key of ['dateFrom', 'dateTo']) if (query[key] !== undefined) {
    const value = query[key]
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(new Date(value).getTime()) || new Date(value).toISOString().slice(0, 10) !== value) throw new HttpError(400, `Invalid ${key}`)
    options[key] = value
  }
  for (const key of ['fromTime', 'toTime']) if (query[key] !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(query[key])) throw new HttpError(400, `Invalid ${key}`)
    options[key] = query[key].split(':').reduce((hour, minute) => hour * 60 + Number(minute), 0)
  }
  options.minAge = number('minAge', 0, 120, undefined, true)
  options.maxAge = number('maxAge', 0, 120, undefined, true)
  if (options.minAge && options.maxAge && options.minAge > options.maxAge) throw new HttpError(400, 'Invalid age range')
  options.minParticipants = number('minParticipants', 2, 1000, undefined, true)
  options.maxParticipants = number('maxParticipants', 2, 1000, undefined, true)
  if (options.dateFrom > options.dateTo || options.fromTime > options.toTime || options.minParticipants > options.maxParticipants) throw new HttpError(400, 'Invalid date, time or member range')
  for (const [key, values] of [['gender', genders], ['religion', religions], ['alcohol', ['yes', 'no']], ['dressCode', ['yes', 'no']]]) {
    if (query[key] !== undefined && !values.includes(query[key])) throw new HttpError(400, `Invalid ${key}`)
    options[key] = query[key]
  }
  if (query.language?.length > 40) throw new HttpError(400, 'Invalid language')
  options.language = query.language
  return options
}

export function createActivityRouter(repository, authRepository, coverStorage) {
  const router = Router()
  router.use(authenticate(authRepository))
  router.get('/', async (req, res) => {
    res.json(await repository.search(searchOptions(req.query), req.auth.user.id, await authRepository.getProfile(req.auth.user.id)))
  })
  router.get('/invitations', async (req, res) => {
    if (Object.keys(req.query).some(key => !['page', 'limit'].includes(key))) throw new HttpError(400, 'Only page and limit are supported')
    const { page, limit } = searchOptions(req.query)
    res.json(await repository.invitations(req.auth.user.id, page, limit))
  })
  router.get('/mine', async (req, res) => {
    if (Object.keys(req.query).some(key => !['page', 'limit'].includes(key))) throw new HttpError(400, 'Only page and limit are supported')
    const { page, limit } = searchOptions(req.query)
    const result = await repository.owned(req.auth.user.id, page, limit)
    res.json({ ...result, items: result.items.map(publicActivity) })
  })
  async function find(id, owner) {
    const row = await repository.get(id)
    if (!row) throw new HttpError(404, 'Activity not found')
    if (owner && row.hostId !== owner) throw new HttpError(403, 'Only the host can change this activity')
    return row
  }
  router.get('/:id', async (req, res) => {
    const row = await find(req.params.id)
    if (row.status !== 'published' && row.hostId !== req.auth.user.id && !row.joinRequests?.some(item => item.userId === req.auth.user.id && item.status === 'approved')) throw new HttpError(404, 'Activity not found')
    const reputation = await authRepository.community?.reputation(row.hostId)
    const host = await authRepository.getProfile(row.hostId)
    const hostAvatarUrl = host?.avatar_url ?? (host?.avatar_version ? `/api/profile/${host.id}/avatar?v=${host.avatar_version}` : null)
    res.json({ activity: { ...publicActivity(row), ...(row.hostId === req.auth.user.id ? { companions: row.companions ?? [] } : {}), hostAvatarUrl, ...(reputation ? { hostRating: reputation.average, hostRatingCount: reputation.count, hostCompletedActivities: reputation.completedActivities } : {}) } })
  })
  const cleanup = async id => { try { await coverStorage.remove(id) } catch { console.warn('Activity cover cleanup failed') } }
  async function cover(base64, owner) {
    if (base64 === undefined) return null
    if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new HttpError(400, 'Invalid cover image')
    const buffer = Buffer.from(base64, 'base64')
    if (buffer.length > 10 * 1024 * 1024) throw new HttpError(413, 'Each image must not exceed 10 MB')
    let image
    try {
      const source = sharp(buffer, { limitInputPixels: 20000000 })
      const info = await source.metadata()
      if (!['jpeg', 'png', 'webp'].includes(info.format) || (info.pages ?? 1) !== 1) throw new Error('Invalid image')
      image = await source.rotate().resize(1200, 900, { fit: 'cover', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer()
    } catch { throw new HttpError(400, 'Select a valid JPEG, PNG or WebP cover') }
    return coverStorage.upload(image, owner)
  }
  async function gallery(body, owner) {
    if (body.photosBase64 === undefined && body.coverBase64 === undefined) return null
    const images = []
    try {
      for (const value of body.photosBase64 ?? [body.coverBase64]) images.push(await cover(value, owner))
      return { imageUrl: images[0]?.url ?? null, imagePublicId: images[0]?.publicId ?? null,
        imageUrls: images.map(image => image.url), imagePublicIds: images.map(image => image.publicId) }
    } catch (error) { await Promise.all(images.map(image => cleanup(image.publicId))); throw error }
  }
  const cleanGallery = async row => { await Promise.all([...new Set(row.imagePublicIds ?? (row.imagePublicId ? [row.imagePublicId] : []))].map(cleanup)) }
  const writes = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, keyGenerator: req => req.auth.user.id, standardHeaders: 'draft-8', legacyHeaders: false })
  const json = express.json({ limit: '16kb' })
  const event = (req, type, details = {}) => ({ id: randomUUID(), type, actorId: req.auth.user.id, createdAt: new Date(), ...details })
  const notifyMembers = async (row, req, key, title) => Promise.all((row.joinRequests ?? []).filter(item => item.status === 'approved').map(member => authRepository.community?.notify(member.userId, { key, type: 'activity', title, text: row.title, activityId: row.id, actorId: req.auth.user.id })))
  function emptyBody(body) {
    if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)) throw new HttpError(400, 'Body must be empty')
  }
  async function saveLifecycle(activity, req, fields, entry) {
    const row = await repository.lifecycle(activity, req.auth.user.id, fields, entry)
    if (!row) throw new HttpError(409, 'Activity changed. Reload and try again.')
    if (['schedule-confirmed', 'started', 'completed', 'note'].includes(entry.type)) {
      const title = entry.type === 'schedule-confirmed' ? 'Host đã chốt lịch đi' : entry.type === 'started' ? 'Hoạt động đã bắt đầu' : entry.type === 'completed' ? 'Hoạt động đã kết thúc' : 'Cập nhật từ host'
      await Promise.all((activity.joinRequests ?? []).filter(item => item.status === 'approved').map(member => authRepository.community?.notify(member.userId, { key: `activity:${entry.id}`, type: 'activity', title, text: entry.text || activity.title, activityId: activity.id, actorId: req.auth.user.id })))
    }
    return row
  }
  router.post('/:id/confirm-schedule', writes, json, async (req, res) => {
    if (!req.body || Object.keys(req.body).length !== 1 || !Number.isInteger(req.body.version)) throw new HttpError(400, 'Provide the current activity version')
    const activity = await find(req.params.id, req.auth.user.id)
    if (activity.status !== 'published' || activity.startsAt <= new Date()) throw new HttpError(409, 'Chỉ chốt lịch cho hoạt động sắp diễn ra')
    if (req.body.version !== activity.version) throw new HttpError(409, 'Hoạt động đã thay đổi. Tải lại trước khi chốt lịch.')
    const readiness = activityReadiness(activity)
    if (!readiness.ready) throw new HttpError(409, readiness.reason)
    if (activity.scheduleConfirmedAt) { res.json({ activity: publicActivity(activity) }); return }
    if ((activity.updates?.length ?? 0) >= 2000) throw new HttpError(409, 'Activity update limit reached')
    const entry = event(req, 'schedule-confirmed')
    const row = await saveLifecycle(activity, req, { scheduleConfirmedAt: entry.createdAt, scheduleConfirmedBy: req.auth.user.id }, entry)
    res.json({ activity: publicActivity(row) })
  })
  for (const action of ['start', 'complete']) {
    router.post(`/:id/${action}`, writes, json, async (req, res) => {
      emptyBody(req.body)
      const activity = await find(req.params.id, req.auth.user.id)
      const starting = action === 'start'
      if (activity.status !== (starting ? 'published' : 'in-progress')) throw new HttpError(409, 'Invalid activity transition')
      if (starting) {
        const readiness = activityReadiness(activity)
        if (!readiness.ready) throw new HttpError(409, readiness.reason)
        if (!activity.scheduleConfirmedAt) throw new HttpError(409, 'Cần chốt lịch trước khi bắt đầu hoạt động.')
        if (activity.endsAt && activity.endsAt <= new Date()) throw new HttpError(409, 'Hoạt động đã hết thời gian.')
      } else if (!activity.attendance?.length || activity.attendance.some(member => member.status === 'unmarked')) {
        throw new HttpError(409, 'Cần điểm danh tất cả thành viên trước khi kết thúc hoạt động.')
      }
      const entry = event(req, starting ? 'started' : 'completed')
      const fields = starting ? { status: 'in-progress', startedAt: entry.createdAt,
        attendance: [{ userId: activity.hostId, name: activity.hostName },
          ...(activity.joinRequests ?? []).filter(item => item.status === 'approved').map(item => ({ userId: item.userId, name: item.name }))]
          .map(item => ({ ...item, status: 'unmarked' })),
      } : { status: 'completed', completedAt: entry.createdAt }
      const row = await saveLifecycle(activity, req, fields, entry)
      res.json({ activity: publicActivity(row) })
    })
  }
  async function groupActivity(req) {
    const activity = await find(req.params.id)
    if (activity.hostId !== req.auth.user.id && !activity.joinRequests?.some(item => item.userId === req.auth.user.id && item.status === 'approved')) throw new HttpError(403, 'Only host and approved members can view this data')
    return activity
  }
  for (const kind of ['attendance', 'updates']) {
    router.get(`/:id/${kind}`, async (req, res) => {
      const activity = await groupActivity(req)
      if (Object.keys(req.query).some(key => !['page', 'limit'].includes(key))) throw new HttpError(400, 'Only page and limit are supported')
      const { page, limit } = searchOptions(req.query)
      const items = kind === 'updates' ? [...(activity.updates ?? [])].reverse() : activity.attendance ?? []
      res.json({ items: items.slice((page - 1) * limit, page * limit), total: items.length, page, limit, hasMore: page * limit < items.length })
    })
  }
  router.patch('/:id/attendance/:userId', writes, json, async (req, res) => {
    if (!req.body || Array.isArray(req.body) || Object.keys(req.body).length !== 1 || !['present', 'absent', 'late', 'unmarked'].includes(req.body.status)) throw new HttpError(400, 'Provide only status: present, absent, late or unmarked')
    const activity = await find(req.params.id, req.auth.user.id)
    if (activity.status !== 'in-progress') throw new HttpError(409, 'Attendance can only change while in progress')
    const target = activity.attendance?.find(item => item.userId === req.params.userId)
    if (!target) throw new HttpError(404, 'Participant not found in attendance roster')
    if (target.status === req.body.status) { res.json({ attendance: target }); return }
    if ((activity.updates?.length ?? 0) >= 2000) throw new HttpError(409, 'Activity update limit reached')
    const entry = event(req, 'attendance-changed', { userId: target.userId, previousStatus: target.status, status: req.body.status })
    const attendance = activity.attendance.map(item => item.userId === target.userId ? { ...item, status: req.body.status, updatedAt: entry.createdAt, updatedBy: req.auth.user.id } : item)
    await saveLifecycle(activity, req, { attendance }, entry)
    res.json({ attendance: attendance.find(item => item.userId === target.userId) })
  })
  router.post('/:id/updates', writes, json, async (req, res) => {
    if (!req.body || Array.isArray(req.body) || Object.keys(req.body).length !== 1 || typeof req.body.text !== 'string' || !req.body.text.trim() || req.body.text.length > 1000) throw new HttpError(400, 'Provide only text of 1-1000 characters')
    const activity = await find(req.params.id, req.auth.user.id)
    if (activity.status !== 'in-progress') throw new HttpError(409, 'Updates can only be added while in progress')
    if ((activity.updates?.length ?? 0) >= 2000) throw new HttpError(409, 'Activity update limit reached')
    const entry = event(req, 'note', { text: req.body.text.trim() })
    await saveLifecycle(activity, req, {}, entry)
    res.status(201).json({ update: entry })
  })
  router.get('/:id/companions', async (req, res) => {
    const row = await groupActivity(req)
    res.json({ companions: companionFields(row.companions ?? [], row.reservedSeats ?? 0), version: row.version })
  })
  router.patch('/:id/companions', writes, json, async (req, res) => {
    const row = await find(req.params.id, req.auth.user.id)
    if (row.organizerType === 'business') throw new HttpError(403, 'Sự kiện doanh nghiệp chỉ nhận thành viên có tài khoản đăng ký.')
    if (!req.body || Object.keys(req.body).length !== 2 || !Number.isInteger(req.body.version) || req.body.version !== row.version) throw new HttpError(409, 'Hoạt động đã thay đổi. Tải lại trước khi lưu.')
    if (row.status !== 'published' || row.startsAt <= new Date()) throw new HttpError(409, 'Chỉ sửa người đi cùng trước khi hoạt động bắt đầu')
    const companions = companionFields(req.body.companions, row.reservedSeats ?? 0)
    const updated = await repository.update(row, { companions })
    if (!updated) throw new HttpError(409, 'Activity changed. Reload and try again.')
    res.json({ companions, version: updated.version })
  })
  router.get('/:id/members', async (req, res) => {
    const activity = await find(req.params.id)
    const approved = (activity.joinRequests ?? []).filter(item => item.status === 'approved')
    if (activity.hostId !== req.auth.user.id && !approved.some(item => item.userId === req.auth.user.id)) throw new HttpError(403, 'Only host and approved members can view members')
    if (Object.keys(req.query).some(key => !['page', 'limit'].includes(key))) throw new HttpError(400, 'Only page and limit are supported')
    const { page, limit } = searchOptions(req.query)
    approved.sort((a, b) => a.updatedAt - b.updatedAt || a.userId.localeCompare(b.userId))
    const items = [{ userId: activity.hostId, name: activity.hostName, role: 'host' },
      ...approved.map(item => ({ userId: item.userId, name: item.name, role: 'member' }))]
    const paged = await Promise.all(items.slice((page - 1) * limit, page * limit).map(async item => {
      const user = await authRepository.getProfile(item.userId)
      return { ...item, name: user?.name ?? item.name, avatarUrl: user?.avatar_url ?? null }
    }))
    res.json({ items: paged, total: items.length, page, limit, hasMore: page * limit < items.length })
  })
  async function removeMember(req, res, hostAction) {
    const activity = await find(req.params.id, hostAction ? req.auth.user.id : undefined)
    const userId = hostAction ? req.params.userId : req.auth.user.id
    if (userId === activity.hostId) throw new HttpError(403, 'Host cannot leave or be removed')
    if (!activity.joinRequests?.some(item => item.userId === userId && item.status === 'approved')) throw new HttpError(404, 'Approved member not found')
    if (!await repository.removeMember(activity.id, userId, req.auth.user.id, hostAction)) throw new HttpError(409, 'Membership changed or activity is no longer upcoming and published')
    res.status(204).end()
  }
  router.post('/:id/members/friends', writes, json, async (req, res) => {
    const { friendIds, useReservedSeats = true } = req.body ?? {}
    if (!req.body || Object.keys(req.body).some(key => !['friendIds', 'useReservedSeats'].includes(key)) || !Array.isArray(friendIds) || !friendIds.length || friendIds.length > 50 || new Set(friendIds).size !== friendIds.length || friendIds.some(id => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) || typeof useReservedSeats !== 'boolean') throw new HttpError(400, 'Chọn tối đa 50 bạn bè')
    const previous = await find(req.params.id, req.auth.user.id)
    if (previous.organizerType === 'business') throw new HttpError(403, 'Người tham gia sự kiện doanh nghiệp cần tự đăng ký để được xác nhận.')
    if (previous.status !== 'published' || previous.startsAt <= new Date()) throw new HttpError(409, 'Chỉ thêm bạn vào hoạt động chưa bắt đầu')
    const people = await authRepository.resolveFriends(req.auth.user.id, friendIds)
    if (!people) throw new HttpError(403, 'Chỉ thêm được bạn bè đã chấp nhận kết bạn')
    if (people.some(person => !canParticipate(previous.participantPreferences, person))) throw new HttpError(400, 'Một người bạn chưa đáp ứng tùy chọn nhóm')
    const row = await repository.addFriends(previous, people, useReservedSeats)
    if (!row) throw new HttpError(409, 'Không đủ chỗ hoặc nhóm đã thay đổi. Tải lại và thử lại.')
    await notifyInvitations(row, req)
    res.json({ activity: publicActivity(row) })
  })
  async function notifyInvitations(row, req) {
    await Promise.all((row.invitations ?? []).filter(item => item.status === 'pending').map(item => authRepository.community?.notify(item.userId, {
      key: 'invitation:' + item.id, type: 'activity-invitation', title: 'Lời mời tham gia hoạt động', text: req.auth.user.name + ' mời bạn tham gia ' + row.title, activityId: row.id, actorId: req.auth.user.id,
    })))
  }
  router.get('/:id/invitations', async (req, res) => {
    const row = await find(req.params.id, req.auth.user.id)
    res.json({ items: row.invitations ?? [] })
  })
  router.patch('/:id/invitations/:invitationId', writes, json, async (req, res) => {
    if (!req.body || Object.keys(req.body).length !== 1 || !['accepted', 'declined'].includes(req.body.status)) throw new HttpError(400, 'Chọn đồng ý hoặc từ chối lời mời.')
    const previous = await find(req.params.id)
    const invitation = previous.invitations?.find(item => item.id === req.params.invitationId && item.userId === req.auth.user.id)
    if (!invitation) throw new HttpError(404, 'Không tìm thấy lời mời của bạn.')
    if (invitation.status === req.body.status) { res.json({ activity: publicActivity(previous) }); return }
    if (invitation.status !== 'pending') throw new HttpError(409, 'Lời mời đã được xử lý.')
    if (req.body.status === 'accepted') {
      if (!await authRepository.resolveFriends(previous.hostId, [req.auth.user.id]) || await authRepository.community?.blocked(previous.hostId, req.auth.user.id)) throw new HttpError(403, 'Không thể nhận lời mời từ tài khoản này.')
      if (!canParticipate(previous.participantPreferences, await authRepository.getProfile(req.auth.user.id))) throw new HttpError(403, 'Hồ sơ chưa đáp ứng điều kiện hoạt động.')
    }
    const row = await repository.decideInvitation(previous, invitation, req.body.status)
    if (!row) throw new HttpError(409, 'Lời mời không còn khả dụng, nhóm đã đủ chỗ hoặc có thay đổi. Nhóm phải chừa ít nhất một chỗ cho thành viên bên ngoài. Hãy tải lại hoặc nhờ host tăng sức chứa.')
    await authRepository.community?.notify(row.hostId, { key: 'invitation-decision:' + invitation.id, type: 'activity', title: req.body.status === 'accepted' ? 'Bạn bè đã đồng ý tham gia' : 'Bạn bè đã từ chối lời mời', text: req.auth.user.name + ' · ' + row.title, activityId: row.id, actorId: req.auth.user.id })
    res.json({ activity: publicActivity(row) })
  })
  router.delete('/:id/members/me', writes, (req, res) => removeMember(req, res, false))
  router.delete('/:id/members/:userId', writes, (req, res) => removeMember(req, res, true))
  router.post('/:id/join-requests', writes, express.json({ limit: '16kb' }), async (req, res) => {
    if (req.body !== undefined && (!req.body || Array.isArray(req.body) || typeof req.body !== 'object' || Object.keys(req.body).length)) throw new HttpError(400, 'Join request body must be empty')
    const activity = await find(req.params.id)
    if (await authRepository.community?.blocked(req.auth.user.id, activity.hostId)) throw new HttpError(403, 'Không thể tham gia hoạt động của tài khoản đã chặn')
    if (activity.hostId === req.auth.user.id) throw new HttpError(403, 'Host cannot request to join their own activity')
    if (activity.participantPreferences && !canParticipate(activity.participantPreferences, await authRepository.getProfile(req.auth.user.id))) throw new HttpError(403, 'Hồ sơ chưa đáp ứng yêu cầu nhóm. Hãy kiểm tra giới tính, ngôn ngữ và tùy chọn cá nhân trong hồ sơ.')
    const request = await repository.submitJoinRequest(activity.id, req.auth.user, activity.version)
    if (!request) throw new HttpError(409, 'Activity is unavailable, full, request limit reached, or you already have a pending/approved request')
    await authRepository.community?.notify(activity.hostId, { key: `join:${request.id}`, type: 'activity', title: 'Yêu cầu tham gia mới', text: `${req.auth.user.name} muốn tham gia ${activity.title}`, activityId: activity.id, actorId: req.auth.user.id })
    res.status(201).json({ request })
  })
  router.delete('/:id/join-requests/me', writes, async (req, res) => {
    const activity = await find(req.params.id)
    const existing = activity.joinRequests?.find(item => item.userId === req.auth.user.id)
    if (!existing) throw new HttpError(404, 'Join request not found')
    const request = await repository.changeJoinRequest(activity.id, { userId: req.auth.user.id, status: 'cancelled' })
    if (!request) throw new HttpError(409, 'Only pending requests for upcoming published activities can be cancelled')
    res.status(204).end()
  })
  router.get('/:id/join-requests', async (req, res) => {
    const activity = await find(req.params.id, req.auth.user.id)
    const { status, ...pagination } = req.query
    if (status !== undefined && !['pending', 'approved', 'rejected', 'cancelled', 'left', 'removed'].includes(status)) throw new HttpError(400, 'Invalid request status')
    if (Object.keys(pagination).some(key => !['page', 'limit'].includes(key))) throw new HttpError(400, 'Only status, page and limit are supported')
    const { page, limit } = searchOptions(pagination)
    const items = (activity.joinRequests ?? []).filter(item => !status || item.status === status)
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    res.json({ items: items.slice((page - 1) * limit, page * limit), total: items.length, page, limit, hasMore: page * limit < items.length })
  })
  router.patch('/:id/join-requests/:requestId', writes, express.json({ limit: '16kb' }), async (req, res) => {
    if (!req.body || Array.isArray(req.body) || Object.keys(req.body).length !== 1 || !['approved', 'rejected'].includes(req.body.status)) throw new HttpError(400, 'Provide only status: approved or rejected')
    const activity = await find(req.params.id, req.auth.user.id)
    if (!activity.joinRequests?.some(item => item.id === req.params.requestId)) throw new HttpError(404, 'Join request not found')
    const request = await repository.changeJoinRequest(activity.id, { hostId: req.auth.user.id, requestId: req.params.requestId, status: req.body.status })
    if (!request) throw new HttpError(409, 'Request is no longer pending, activity unavailable, or capacity reached')
    await authRepository.community?.notify(request.userId, { key: `decision:${request.id}:${request.status}`, type: 'activity', title: request.status === 'approved' ? 'Yêu cầu đã được duyệt' : 'Yêu cầu chưa được duyệt', text: activity.title, activityId: activity.id, actorId: req.auth.user.id })
    res.json({ request })
  })
  router.get('/:id/plan-file', async (req, res) => {
    const row = await repository.getWithPlanFile(req.params.id)
    if (!row) throw new HttpError(404, 'Activity not found')
    if (row.status !== 'published' && row.hostId !== req.auth.user.id && !row.joinRequests?.some(item => item.userId === req.auth.user.id && item.status === 'approved')) throw new HttpError(403, 'Activity access denied')
    if (!row.planFile || !row.planFileData) throw new HttpError(404, 'Không có tệp kế hoạch')
    if (req.query.version && req.query.version !== row.planFile.id) throw new HttpError(409, 'Tệp đã được thay thế. Tải lại kế hoạch.')
    res.attachment(row.planFile.name).type('application/octet-stream').send(Buffer.isBuffer(row.planFileData) ? row.planFileData : Buffer.from(row.planFileData.buffer))
  })
  router.patch('/:id/plan', writes, express.json({ limit: '5mb' }), async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some(key => ![...planKeys, 'version'].includes(key)) || !planKeys.some(key => Object.hasOwn(req.body, key))) throw new HttpError(400, 'Invalid plan update')
    const previous = await find(req.params.id, req.auth.user.id)
    if (req.body.version !== (previous.version ?? 0)) throw new HttpError(409, 'Kế hoạch đã thay đổi. Tải lại trước khi lưu.')
    const row = await repository.savePlan(previous, planningFields(req.body, previous))
    if (!row) throw new HttpError(409, 'Hoạt động đã kết thúc hoặc kế hoạch đã thay đổi')
    await notifyMembers(row, req, `plan:${row.id}:${row.version}`, 'Host đã cập nhật kế hoạch')
    res.json({ activity: publicActivity(row) })
  })
  router.post('/', writes, express.json({ limit: '86mb' }), async (req, res) => {
    const fields = activityFields(req.body)
    if (fields.organizerType === 'business') throw new HttpError(403, 'Bài đăng doanh nghiệp chỉ được tạo qua nền tảng website dành cho doanh nghiệp.')
    if (fields.financialConfig && fields.financialConfig.treasurerUserId !== req.auth.user.id) throw new HttpError(400, 'Treasurer must be the activity host')
    const initialMembers = await authRepository.resolveFriends(req.auth.user.id, fields.initialFriendIds ?? [])
    if (!initialMembers) throw new HttpError(403, 'Chỉ thêm được bạn bè đã chấp nhận kết bạn')
    if (initialMembers.some(person => !canParticipate(fields.participantPreferences, person))) throw new HttpError(400, 'Một người bạn chưa đáp ứng tùy chọn nhóm')
    const images = await gallery(req.body, req.auth.user.id)
    try {
      const row = await repository.create({ ...fields, initialMembers, ...(images ?? {}) }, req.auth.user)
      await notifyInvitations(row, req)
      res.status(201).json({ activity: publicActivity(row) })
    } catch (error) { if (images) await cleanGallery(images); throw error }
  })
  router.patch('/:id', writes, express.json({ limit: '86mb' }), async (req, res) => {
    const previous = await find(req.params.id, req.auth.user.id)
    if (previous.organizerType === 'business' || req.body?.organizerType === 'business') throw new HttpError(403, 'Quản lý bài đăng doanh nghiệp trên nền tảng website dành cho doanh nghiệp.')
    if (previous.status !== 'published' || previous.startsAt <= new Date()) throw new HttpError(409, 'Started activities cannot be edited')
    const fields = activityFields(req.body, previous)
    const scheduleKeys = ['minParticipants', 'maxParticipants', 'reservedSeats', 'participantPreferences', 'startsAt', 'endsAt', 'location', 'meetingPoint', 'address', 'province', 'district', 'ward', 'coordinates']
    if (scheduleKeys.some(key => Object.hasOwn(fields, key) && JSON.stringify(fields[key]) !== JSON.stringify(previous[key]))) {
      fields.scheduleConfirmedAt = null
      fields.scheduleConfirmedBy = null
    }
    if (fields.financialConfig && fields.financialConfig.treasurerUserId !== req.auth.user.id) throw new HttpError(400, 'Treasurer must be the activity host')
    const images = await gallery(req.body, req.auth.user.id)
    let row
    try {
      row = await repository.update(previous, { ...fields, ...(images ?? {}) })
      if (!row) throw new HttpError(409, 'Activity changed. Reload and try again.')
    } catch (error) { if (images) await cleanGallery(images); throw error }
    if (images) await cleanGallery(previous)
    await notifyMembers(row, req, `edited:${row.id}:${row.version}`, 'Host đã cập nhật hoạt động')
    res.json({ activity: publicActivity(row) })
  })
  router.delete('/:id', writes, async (req, res) => {
    const previous = await find(req.params.id, req.auth.user.id)
    if (!await repository.remove(previous)) throw new HttpError(409, 'Activity changed. Reload and try again.')
    await cleanGallery(previous)
    await notifyMembers(previous, req, `deleted:${previous.id}`, 'Hoạt động đã bị hủy')
    res.status(204).end()
  })
  return router
}
