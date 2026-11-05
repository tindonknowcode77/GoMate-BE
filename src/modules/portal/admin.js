import { Router } from 'express'
import express from 'express'
import { randomUUID } from 'node:crypto'
import { HttpError } from '../../common/http-error.js'
import { hashPassword } from '../auth/password.js'
import { credentials } from '../auth/validation.js'
import { fields, email, phone, version } from './validation.js'
import { verificationDocument } from './documents.js'
import { adminText, adminId, adminQuery, adminPostFields, adminApplicationFields } from './admin-validation.js'

const collections = { users: 'users', businesses: 'business_applications', posts: 'business_posts', reports: 'reports', tickets: 'support_tickets' }
const userProjection = { _id: 0, id: 1, name: 1, email: 1, role: 1, subscription: 1, email_verified: 1, created_at: 1, adminVersion: 1 }
const projection = { _id: 0, document: 0, lifecycleTasks: 0, key: 0 }
const revision = row => row.adminVersion ?? 0
const matchRevision = value => value === 0 ? { $in: [null, 0] } : value

export function createAdminRepository(db) {
  const collection = kind => db.collection(collections[kind])
  const audit = (actorId, action) => ({ actorId, action, at: new Date() })
  async function get(kind, id) {
    const row = await collection(kind).findOne({ id, deletedAt: { $exists: false }, ...(['businesses', 'posts'].includes(kind) ? { status: { $ne: 'deleted' } } : {}) }, { projection: kind === 'users' ? userProjection : projection })
    if (!row) throw new HttpError(404, 'Không tìm thấy dữ liệu')
    return { ...row, adminVersion: revision(row), ...(['businesses', 'posts'].includes(kind) ? { version: row.version ?? 0 } : {}) }
  }
  async function update(kind, id, expected, patch, actorId, extra = {}) {
    const row = await collection(kind).findOneAndUpdate({ id, deletedAt: { $exists: false }, adminVersion: matchRevision(expected), ...extra }, {
      $set: { ...patch, updatedAt: new Date() }, $inc: { adminVersion: 1, ...(kind === 'businesses' ? { version: 1 } : {}) },
      $push: { adminHistory: audit(actorId, patch.deletedAt ? 'delete' : 'update') },
    }, { returnDocument: 'after', projection: kind === 'users' ? userProjection : projection })
    if (!row) throw new HttpError(409, 'Dữ liệu đã thay đổi hoặc không còn tồn tại. Vui lòng tải lại.')
    return row
  }
  return {
    get, update,
    async recordCreation(kind, id, actorId) {
      await collection(kind).updateOne({ id }, { $push: { adminHistory: audit(actorId, 'create') } })
    },
    async list(kind, page, q, status) {
      const filter = { deletedAt: { $exists: false }, ...(['businesses', 'posts'].includes(kind) ? { status: { $ne: 'deleted' } } : {}), ...(status ? { status } : {}) }
      const searchFields = { users: ['name', 'email'], businesses: ['company', 'representativeEmail'], posts: ['title', 'businessName'], reports: ['reason', 'detail', 'activityId'], tickets: ['subject', 'ownerId'] }
      if (q) { const pattern = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); filter.$or = searchFields[kind].map(key => ({ [key]: { $regex: pattern, $options: 'i' } })) }
      const items = await collection(kind).find(filter, { projection: kind === 'users' ? userProjection : projection }).sort({ createdAt: -1, created_at: -1, id: 1 }).skip((page - 1) * 20).limit(20).toArray()
      return { items: items.map(row => ({ ...row, adminVersion: revision(row), ...(['businesses', 'posts'].includes(kind) ? { version: row.version ?? 0 } : {}) })), total: await collection(kind).countDocuments(filter) }
    },
    async createUser(body, actorId) {
      const data = credentials(body, true)
      data.name = adminText(data.name, 'Họ tên', 100, { min: 2 })
      if (!data.password.trim()) throw new HttpError(400, 'Mật khẩu không được chỉ chứa khoảng trắng.')
      const row = { id: randomUUID(), name: data.name, email: data.email, password_hash: await hashPassword(data.password), role: 'user', email_verified: false, created_at: new Date(), adminVersion: 1, adminHistory: [audit(actorId, 'create')] }
      try { await collection('users').insertOne(row) } catch (error) { if (error.code === 11000) throw new HttpError(409, 'Email đã được sử dụng'); throw error }
      return get('users', row.id)
    },
    async deleteUser(id, expected, actorId) {
      const row = await get('users', id)
      if (id === actorId || row.role === 'admin') throw new HttpError(409, 'Không thể xóa chính mình hoặc quản trị viên. Hãy đổi quyền trước.')
      if (await db.collection('business_applications').findOne({ ownerId: id, status: { $in: ['pending', 'approved'] } }) || await db.collection('activities').findOne({ hostId: id, status: { $nin: ['deleted', 'cancelled', 'completed'] } })) throw new HttpError(409, 'Hãy xử lý hồ sơ doanh nghiệp và hoạt động đang mở trước khi xóa tài khoản.')
      return update('users', id, expected, { deletedAt: new Date(), deletedBy: actorId }, actorId, { role: { $ne: 'admin' } })
    },
    async deleteBusiness(id, expected, actorId, currentVersion) {
      const row = await get('businesses', id)
      if (await db.collection('business_posts').findOne({ ownerId: row.ownerId, status: { $in: ['approved', 'publishing', 'pending'] } })) throw new HttpError(409, 'Hãy thu hồi hoặc xóa các bài đăng đang mở trước khi xóa doanh nghiệp.')
      return update('businesses', id, expected, { status: 'deleted', deletedAt: new Date(), deletedBy: actorId }, actorId, { version: matchRevision(currentVersion) })
    },
    async createReport(data, actorId) {
      if (!await db.collection('activities').findOne({ id: data.activityId, status: { $ne: 'deleted' } })) throw new HttpError(404, 'Hoạt động không tồn tại')
      const row = { ...data, id: randomUUID(), key: 'admin:' + randomUUID(), reporterId: actorId, status: 'pending', createdAt: new Date(), adminVersion: 1, adminHistory: [audit(actorId, 'create')] }
      await collection('reports').insertOne(row)
      return get('reports', row.id)
    },
  }
}

export function createAdminRouter(auth, writes) {
  const router = Router(), repo = auth.portal, admin = repo.admin
  router.use((req, _res, next) => { if (req.portalRole !== 'admin') throw new HttpError(403, 'Chỉ quản trị viên có quyền truy cập'); next() })
  router.use((req, res, next) => ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? next() : writes(req, res, next))
  const smallBody = express.json({ limit: '32kb' }), documentBody = express.json({ limit: '28mb' })
  router.use((req, res, next) => (req.method === 'POST' && req.path === '/businesses' ? documentBody : smallBody)(req, res, next))
  router.param('kind', (req, _res, next, kind) => { if (!Object.hasOwn(collections, kind)) throw new HttpError(404, 'Không tìm thấy mục quản lý'); next() })
  router.param('id', (req, _res, next, id) => { adminId(id); next() })
  router.get('/:kind', async (req, res) => {
    const { page, q, status } = adminQuery(req.params.kind, req.query)
    res.json(await admin.list(req.params.kind, page, q, status))
  })
  router.get('/:kind/:id', async (req, res) => res.json(await admin.get(req.params.kind, req.params.id)))
  router.post('/:kind', async (req, res) => {
    const { kind } = req.params, actorId = req.auth.user.id, body = req.body
    let result
    if (kind === 'users') { fields(body, ['name', 'email', 'password']); result = await admin.createUser(body, actorId) }
    if (kind === 'businesses') {
      fields(body, ['ownerId', 'application'])
      const ownerId = adminId(body.ownerId)
      await admin.get('users', ownerId)
      const data = adminApplicationFields(body.application)
      if (data.document) data.document = await verificationDocument(data.document)
      if (data.supplementalDocument) data.supplementalDocument = await verificationDocument(data.supplementalDocument)
      result = await repo.apply(ownerId, data)
    }
    if (kind === 'posts') { fields(body, ['ownerId', 'post']); const ownerId = adminId(body.ownerId); await admin.get('users', ownerId); result = await repo.createPost(ownerId, adminPostFields(body.post)) }
    if (kind === 'reports') { fields(body, ['activityId', 'reason', 'detail']); result = await admin.createReport({ activityId: adminId(body.activityId), reason: adminText(body.reason, 'Lý do', 150), detail: adminText(body.detail, 'Mô tả', 1000, { optional: true }) }, actorId) }
    if (kind === 'tickets') { fields(body, ['ownerId', 'subject', 'message']); const ownerId = adminId(body.ownerId); await admin.get('users', ownerId); result = await repo.createTicket(ownerId, adminText(body.subject, 'Tiêu đề', 150), adminText(body.message, 'Nội dung', 3000)) }
    if (['businesses', 'posts', 'tickets'].includes(kind)) await admin.recordCreation(kind, result.id, actorId)
    res.status(201).json(result)
  })
  router.put('/:kind/:id', async (req, res) => {
    const { kind, id } = req.params, body = req.body, actorId = req.auth.user.id
    fields(body, { users: ['adminVersion', 'name'], businesses: ['adminVersion', 'version', 'company', 'address', 'website', 'representativeName', 'representativeTitle', 'representativeEmail', 'representativePhone'], posts: ['adminVersion', 'version', 'post'], reports: ['adminVersion', 'detail'], tickets: ['adminVersion', 'subject', 'status'] }[kind])
    const expected = version(body.adminVersion)
    let patch, extra = {}
    const row = await admin.get(kind, id)
    if (expected !== row.adminVersion) throw new HttpError(409, 'Dữ liệu đã thay đổi. Vui lòng tải lại.')
    if (kind === 'users') {
      fields(body, ['adminVersion', 'name'])
      patch = { name: adminText(body.name, 'Họ tên', 100, { min: 2 }) }
    }
    if (kind === 'businesses') {
      fields(body, ['adminVersion', 'version', 'company', 'address', 'website', 'representativeName', 'representativeTitle', 'representativeEmail', 'representativePhone'])
      const website = adminText(body.website, 'Website', 500, { optional: true })
      if (website) { let url; try { url = new URL(website) } catch { throw new HttpError(400, 'Website không hợp lệ') }; if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new HttpError(400, 'Website không hợp lệ') }
      patch = { company: adminText(body.company, 'Tên doanh nghiệp', 150), address: adminText(body.address, 'Địa chỉ', 500), website, representativeName: adminText(body.representativeName, 'Người đại diện', 120), representativeTitle: adminText(body.representativeTitle, 'Chức danh', 80), representativeEmail: email(body.representativeEmail), representativePhone: phone(body.representativePhone) }
      extra = { version: matchRevision(version(body.version)) }
    }
    if (kind === 'posts') {
      fields(body, ['adminVersion', 'version', 'post'])
      // Published event changes must use the existing activity lifecycle.
      res.json(await repo.editPost(id, row.ownerId, version(body.version), adminPostFields(body.post))); return
    }
    if (kind === 'reports') { fields(body, ['adminVersion', 'detail']); if (row.status !== 'pending') throw new HttpError(409, 'Báo cáo đã được xử lý'); patch = { detail: adminText(body.detail, 'Mô tả', 1000, { optional: true }) }; extra = { status: 'pending' } }
    if (kind === 'tickets') { fields(body, ['adminVersion', 'subject', 'status']); if (!['open', 'closed'].includes(body.status)) throw new HttpError(400, 'Trạng thái không hợp lệ'); patch = { subject: adminText(body.subject, 'Tiêu đề', 150), status: body.status } }
    res.json(await admin.update(kind, id, version(body.adminVersion), patch, actorId, extra))
  })
  router.delete('/:kind/:id', async (req, res) => {
    fields(req.body, ['adminVersion', 'version'])
    const { kind, id } = req.params, actorId = req.auth.user.id
    const expected = version(req.body.adminVersion)
    if (kind === 'users') return res.json(await admin.deleteUser(id, expected, actorId))
    if (kind === 'businesses') return res.json(await admin.deleteBusiness(id, expected, actorId, version(req.body.version)))
    if (kind === 'posts') return res.json(await repo.postLifecycle(id, actorId, true, version(req.body.version), 'delete'))
    const row = await admin.get(kind, id)
    if (kind === 'reports' && row.status === 'pending' || kind === 'tickets' && row.status === 'open') throw new HttpError(409, 'Hãy xử lý và đóng mục này trước khi xóa.')
    res.json(await admin.update(kind, id, expected, { deletedAt: new Date(), deletedBy: actorId }, actorId, { status: row.status }))
  })
  return router
}
