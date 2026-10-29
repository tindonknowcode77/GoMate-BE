import { createBusinessOperations } from './operations.js'
import { randomUUID } from 'node:crypto'
import { HttpError } from '../../common/http-error.js'
import { createCommunityRepository } from '../community/repository.js'
import { activityFields } from '../activities/validation.js'

const publicRow = { _id: 0, document: 0 }
export function createPortalRepository(db) {
  const community = createCommunityRepository(db)
  const notify = (userId, key, title, text, actorId) => community.notify(userId, { key, type: 'business-update', title, text, actorId })
  const applications = db.collection('business_applications'), posts = db.collection('business_posts')
  const users = db.collection('users'), tickets = db.collection('support_tickets')
  const page = async (collection, filter, offset, projection = publicRow) => ({
    items: await collection.find(filter, { projection }).sort({ createdAt: -1, id: 1 }).skip(offset).limit(20).toArray(),
    total: await collection.countDocuments(filter),
  })
  return {
    operations: createBusinessOperations(db),
    async me(id) {
      const user = await users.findOne({ id }, { projection: { id: 1, name: 1, email: 1, role: 1, subscription: 1, _id: 0 } })
      if (!user) throw new HttpError(401, 'Account not found')
      const application = await applications.findOne({ ownerId: id }, { projection: publicRow })
      return { ...user, role: user.role || 'user', subscription: user.subscription || { plan: 'free', status: 'active' },
        application: application ? {...application,version:application.version ?? 0} : null }
    },
    async apply(ownerId, data) {
      const previous = await applications.findOne({ ownerId })
      if (previous && previous.status !== 'rejected') throw new HttpError(409, 'An application is already pending or approved')
      if (previous && data.version !== (previous.version ?? 0)) throw new HttpError(409, 'Hồ sơ đã thay đổi. Tải lại trước khi gửi lại.')
      if (!data.document && !previous?.document) throw new HttpError(400, 'Business license is required')
      if (data.taxId && await applications.findOne({ ownerId: { $ne: ownerId }, taxId: data.taxId, status: { $in: ['pending', 'approved'] } })) throw new HttpError(409, 'Mã số thuế đang được sử dụng.')
      const { version: _version, ...stored } = data
      let row
      try {
        row = await applications.findOneAndUpdate(previous ? { ownerId, status: 'rejected', version: previous.version ?? { $exists: false } } : { ownerId, status: 'rejected' }, {
          $set: { ...stored, ...(data.document ? { license: { name: data.document.name, mime: data.document.mime, size: Buffer.from(data.document.base64, 'base64').length } } : {}), status: 'pending', updatedAt: new Date(), reviewNote: '' },
          $unset: { reviewedBy: '', reviewedAt: '' },
          $setOnInsert: { id: randomUUID(), ownerId, createdAt: new Date() }, $inc: { version: 1 },
          $push: { history: { type: previous ? 'resubmitted' : 'submitted', actorId: ownerId, createdAt: new Date() } },
        }, { upsert: !previous, returnDocument: 'after', projection: publicRow })
      } catch (error) { if (error.code === 11000) throw new HttpError(409, 'Hồ sơ hoặc mã số thuế đang được sử dụng.'); throw error }
      if (!row) throw new HttpError(409, 'Hồ sơ đã thay đổi. Tải lại trước khi gửi lại.')
      return row
    },
    async applications(offset) { const result=await page(applications,{},offset);return {...result,items:result.items.map(row=>({...row,version:row.version ?? 0}))} },
    async document(id, actorId, reviewer) {
      const row = await applications.findOne({ id, ...(!reviewer ? { ownerId: actorId } : {}) })
      if (!row) throw new HttpError(404, 'Application not found')
      return row.document
    },
    async decideApplication(id, status, reviewNote, actorId, version) {
      if (status === 'rejected' && !reviewNote.trim()) throw new HttpError(400, 'Cần ghi lý do từ chối hồ sơ.')
      const previous = await applications.findOne({id},{projection:{status:1,version:1}})
      if(!previous || (version!==undefined && version!==(previous.version ?? 0))) throw new HttpError(409,'Application changed')
      const row = await applications.findOneAndUpdate({ id, status: 'pending', version: previous.version ?? {$exists:false} }, {
        $set: { status, reviewNote, reviewedBy: actorId, reviewedAt: new Date() }, $inc: { version: 1 },
        $push: { history: { type: status, actorId, note: reviewNote, createdAt: new Date() } },
      }, { returnDocument: 'after', projection: publicRow })
      if (!row) throw new HttpError(409, 'Application was already reviewed, changed or not found')
      await notify(row.ownerId, 'business-application:' + row.id + ':' + row.version, status === 'approved' ? 'Hồ sơ doanh nghiệp đã được duyệt' : 'Hồ sơ doanh nghiệp cần cập nhật', reviewNote || row.company, actorId)
      return row
    },
    async access(id) {
      const user = await users.findOne({ id }, { projection: { role: 1 } })
      if (['admin', 'staff'].includes(user?.role)) return user.role
      if (await applications.findOne({ ownerId: id, status: 'approved' })) return 'business'
      const grants = await db.collection('business_staff').find({ userId: id, status: 'approved', acceptedAt: { $ne: null } }).toArray()
      return grants.length && await applications.findOne({ ownerId: { $in: grants.map(grant => grant.ownerId) }, status: 'approved' }) ? 'business-staff' : 'user'
    },
    async posts(ownerId,offset) { const result=await page(posts,ownerId?{ownerId}:{},offset);return {...result,items:result.items.map(row=>({...row,version:row.version ?? 0}))} },
    async createPost(ownerId, data) {
      const user = await users.findOne({ id: ownerId })
      if (data.premium && !(user?.subscription?.plan === 'plus' && user.subscription.status === 'active')) throw new HttpError(403, 'An active Plus plan is required for premium styling')
      const application = await applications.findOne({ ownerId, status: 'approved' })
      if (!application) throw new HttpError(403, 'A verified business is required')
      for (const group of data.groups ?? []) if(group.locationId) { const place=await db.collection('business_locations').findOne({id:group.locationId,ownerId});if(!place)throw new HttpError(400,'Địa điểm không thuộc doanh nghiệp.');group.event.coordinates={type:'Point',coordinates:[place.longitude,place.latitude]}; }
      const groups = data.groups?.map(group => ({ ...group, activityId: randomUUID() }))
      const row = { ...data, ...(groups ? { groups } : {}), id: randomUUID(), ...(data.event ? { activityId: randomUUID() } : {}), ownerId, businessName: application.company, status: 'pending', version: 1, history: [{ type: 'submitted', actorId: ownerId, createdAt: new Date() }], createdAt: new Date(), updatedAt: new Date() }
      await posts.insertOne(row)
      const { _id, ...result } = row
      return result
    },
    async editPost(id, ownerId, version, data) {
      const previous = await posts.findOne({ id, ownerId })
      if (!previous) throw new HttpError(404, 'Post not found')
      if (!['pending', 'rejected'].includes(previous.status)) throw new HttpError(409, 'Chỉ sửa bài chờ duyệt hoặc bị từ chối.')
      const user = await users.findOne({ id: ownerId })
      if (data.premium && !(user?.subscription?.plan === 'plus' && user.subscription.status === 'active')) throw new HttpError(403, 'Plus is required')
      for (const group of data.groups ?? []) if(group.locationId) { const place=await db.collection('business_locations').findOne({id:group.locationId,ownerId});if(!place)throw new HttpError(400,'Địa điểm không thuộc doanh nghiệp.');group.event.coordinates={type:'Point',coordinates:[place.longitude,place.latitude]}; }
      if (version !== (previous.version ?? 0)) throw new HttpError(409, 'Post changed. Reload before editing.')
      const groups = data.groups?.map((group, index) => ({ ...group, activityId: previous.groups?.[index]?.activityId || randomUUID() }))
      const row = await posts.findOneAndUpdate({ id, ownerId, version: previous.version ?? { $exists: false }, status: previous.status }, {
        $set: { ...data, ...(groups ? { groups } : {}), status: 'pending', reviewNote: '', updatedAt: new Date(), ...(data.event ? { activityId: previous.activityId || randomUUID() } : {}) },
        $unset: { reviewedAt: '', reviewedBy: '', ...(!groups ? { groups: '' } : {}), ...(!data.event ? { event: '', activityId: '' } : {}) },
        $inc: { version: 1 }, $push: { history: { type: 'resubmitted', actorId: ownerId, createdAt: new Date() } },
      }, { returnDocument: 'after', projection: publicRow })
      if (!row) throw new HttpError(409, 'Post changed. Reload before editing.')
      return row
    },
    async withdrawPost(id, ownerId, version) {
      const row = await posts.findOneAndUpdate({ id, ownerId, status: { $in: ['pending', 'rejected'] }, version: version===0 ? {$exists:false} : version }, { $set: { status: 'withdrawn', updatedAt: new Date() }, $inc: { version: 1 }, $push: { history: { type: 'withdrawn', actorId: ownerId, createdAt: new Date() } } }, { returnDocument: 'after', projection: publicRow })
      if (!row) throw new HttpError(409, 'Post changed or cannot be withdrawn')
      return row
    },
    async decidePost(id, status, reviewNote, actorId, version) {
      const previous = await posts.findOne({ id })
      if (!previous) throw new HttpError(404, 'Post not found')
      if (version !== undefined && version !== (previous.version ?? 0)) throw new HttpError(409, 'Post changed')
      if (status === 'rejected' && !reviewNote.trim()) throw new HttpError(400, 'Cần ghi lý do từ chối bài đăng.')
      const groups = previous.groups || (previous.event ? [{ name: previous.title, activityId: previous.activityId, event: previous.event, depositAmount: 0 }] : [])
      const publishing = status === 'approved' && groups.length
      if (publishing) for (const group of groups) activityFields({ ...group.event, startsAt: new Date(group.event.startsAt).toISOString(), endsAt: new Date(group.event.endsAt).toISOString(), ...(group.event.registrationDeadline ? { registrationDeadline: new Date(group.event.registrationDeadline).toISOString() } : {}) })
      const application = await applications.findOne({ ownerId: previous.ownerId, status: 'approved' })
      if (!application) throw new HttpError(403, 'Business verification is required')
      const now = new Date()
      const row = await posts.findOneAndUpdate({ id, version: previous.version ?? { $exists: false }, $or: [{ status: 'pending' }, ...(publishing ? [{ status: 'publishing', publishLeaseUntil: { $lt: now } }] : [])] }, {
        $set: { status: publishing ? 'publishing' : status, reviewNote, reviewedBy: actorId, reviewedAt: now, publishLeaseUntil: new Date(+now + 30000) },
        ...(!publishing ? { $inc: { version: 1 }, $push: { history: { type: status, actorId, note: reviewNote, createdAt: now } } } : {}),
      }, { returnDocument: 'after', projection: publicRow })
      if (!row) throw new HttpError(409, 'Post was already reviewed, is publishing or changed')
      if (publishing) {
        try {
          for (const group of groups) await db.collection('activities').updateOne({ id: group.activityId, status: { $in: ['pending-review'] } }, { $set: {
            ...group.event, title: previous.groups ? (row.title+' · '+group.name).slice(0,120) : row.title, businessCampaignTitle: row.title, id: group.activityId, organizerType: 'business', hostId: row.ownerId, hostName: application.company, businessPostId: row.id, businessGroupName: group.name, businessLocationId: group.locationId || '', depositAmount: group.depositAmount || 0,
            business: { name: application.company, verified: true, depositAmount: group.depositAmount || 0, discountPercent: row.discountPercent || 0, offer: row.offer || row.discount || '', terms: row.offerTerms || '' },
            status: 'pending-review', memberCount: 1, reservedSeats: 0, version: 1, tags: ['Doanh nghiệp'], requirements: [], scheduleConfirmedAt: null, scheduleConfirmedBy: null, createdAt: now, updatedAt: now,
          } }, { upsert: true })
          await posts.updateOne({ id, status: 'publishing' }, { $set: { status: 'approved', updatedAt: now }, $inc: { version: 1 }, $push: { history: { type: 'approved', actorId, note: reviewNote, createdAt: now } } })
          await db.collection('activities').updateMany({ businessPostId: id, status: 'pending-review' }, { $set: { status: 'published' } })
          row.status = 'approved'; row.version = (previous.version ?? 0) + 1
        } catch (error) {
          await posts.updateOne({ id, status: 'publishing' }, { $set: { status: 'pending' } })
          throw error
        }
      }
      await notify(row.ownerId, 'business-post:' + row.id + ':' + row.version, status === 'approved' ? 'Bài đăng doanh nghiệp đã được duyệt' : 'Bài đăng doanh nghiệp cần cập nhật', reviewNote || row.title, actorId)
      return row
    },
    async reconcilePublications() {
      const staged = await db.collection('activities').find({ status: 'pending-review' }, { projection: { id: 1, businessPostId: 1 } }).limit(500).toArray()
      for (const activity of staged) if (await posts.findOne({ id: activity.businessPostId, status: 'approved' })) await db.collection('activities').updateOne({ id: activity.id, status: 'pending-review' }, { $set: { status: 'published' } })
    },
    async notifications(userId, offset) { return page(db.collection('notifications'), { userId, type: /^business-/ }, offset, { _id: 0 }) },
    feed: offset => page(posts, { status: 'approved' }, offset, { _id: 0, reviewedBy: 0, reviewNote: 0, reviewedAt: 0, history: 0, publishLeaseUntil: 0 }),
    async users(offset) {
      const result = await page(users, {}, offset, { _id: 0, id: 1, name: 1, email: 1, role: 1, email_verified: 1, subscription: 1, created_at: 1 })
      const approved = await applications.find({ ownerId: { $in: result.items.map(user => user.id) }, status: 'approved' }, { projection: { ownerId: 1 } }).toArray()
      const businesses = new Set(approved.map(item => item.ownerId))
      return { ...result, items: result.items.map(user => ({ ...user, effectiveRole: ['admin', 'staff'].includes(user.role) ? user.role : businesses.has(user.id) ? 'business' : 'user' })) }
    },
    async setRole(id, role, actorId) {
      if (!['user', 'staff', 'admin'].includes(role)) throw new HttpError(400, 'Invalid role')
      if (id === actorId) throw new HttpError(409, 'You cannot change your own role')
      const row = await users.findOneAndUpdate({ id }, {
        $set: { role, updated_at: new Date(), roleUpdatedBy: actorId, roleUpdatedAt: new Date() },
        $inc: { credential_version: 1 },
      }, { returnDocument: 'after', projection: { _id: 0, id: 1, role: 1 } })
      if (!row) throw new HttpError(404, 'User not found')
      return row
    },
    async subscription(id, value, actorId) {
      const row = await users.findOneAndUpdate({ id }, { $set: { subscription: { ...value, updatedBy: actorId, updatedAt: new Date() } } }, { returnDocument: 'after', projection: { _id: 0, id: 1, subscription: 1 } })
      if (!row) throw new HttpError(404, 'User not found')
      return row
    },
    async createTicket(ownerId, subject, message) {
      const row = { id: randomUUID(), ownerId, subject, status: 'open', createdAt: new Date(), messages: [{ id: randomUUID(), authorId: ownerId, text: message, createdAt: new Date() }] }
      await tickets.insertOne(row)
      const { _id, ...result } = row
      return result
    },
    tickets: (ownerId, offset) => page(tickets, ownerId ? { ownerId } : {}, offset),
    async reply(id, ownerId, actorId, message, status) {
      const row = await tickets.findOneAndUpdate({ id, ...(ownerId ? { ownerId } : {}), 'messages.99': { $exists: false } }, {
        $push: { messages: { id: randomUUID(), authorId: actorId, text: message, createdAt: new Date() } },
        $set: { status, updatedAt: new Date() },
      }, { returnDocument: 'after', projection: publicRow })
      if (!row) throw new HttpError(404, 'Ticket not found or message limit reached')
      return row
    },
    async metrics(role, id) {
      if (role === 'business') return { posts: await posts.countDocuments({ ownerId: id }), pendingPosts: await posts.countDocuments({ ownerId: id, status: 'pending' }), approvedPosts: await posts.countDocuments({ ownerId: id, status: 'approved' }) }
      return { approvedPosts: await posts.countDocuments({ status: 'approved' }), users: await users.countDocuments(), pendingBusinesses: await applications.countDocuments({ status: 'pending' }), pendingPosts: await posts.countDocuments({ status: 'pending' }), openTickets: await tickets.countDocuments({ status: 'open' }), openReports: await db.collection('reports').countDocuments({ status: 'pending' }) }
    },
  }
}