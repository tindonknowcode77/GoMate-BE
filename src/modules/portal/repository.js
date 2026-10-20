import { randomUUID } from 'node:crypto'
import { HttpError } from '../../common/http-error.js'
import { activityFields } from '../activities/validation.js'

const publicRow = { _id: 0, document: 0 }
export function createPortalRepository(db) {
  const applications = db.collection('business_applications'), posts = db.collection('business_posts')
  const users = db.collection('users'), tickets = db.collection('support_tickets')
  const page = async (collection, filter, offset, projection = publicRow) => ({
    items: await collection.find(filter, { projection }).sort({ createdAt: -1, id: 1 }).skip(offset).limit(20).toArray(),
    total: await collection.countDocuments(filter),
  })
  return {
    async me(id) {
      const user = await users.findOne({ id }, { projection: { id: 1, name: 1, email: 1, role: 1, subscription: 1, _id: 0 } })
      if (!user) throw new HttpError(401, 'Account not found')
      return { ...user, role: user.role || 'user', subscription: user.subscription || { plan: 'free', status: 'active' },
        application: await applications.findOne({ ownerId: id }, { projection: publicRow }) }
    },
    async apply(ownerId, data) {
      try {
        const row = await applications.findOneAndUpdate({ ownerId, status: { $in: ['rejected'] } }, {
          $set: { ...data, status: 'pending', updatedAt: new Date(), reviewNote: '' },
          $setOnInsert: { id: randomUUID(), ownerId, createdAt: new Date() },
        }, { upsert: true, returnDocument: 'after', projection: publicRow })
        return row
      } catch (error) { if (error.code === 11000) throw new HttpError(409, 'An application is already pending or approved'); throw error }
    },
    applications: offset => page(applications, {}, offset),
    async document(id) {
      const row = await applications.findOne({ id })
      if (!row) throw new HttpError(404, 'Application not found')
      return row.document
    },
    async decideApplication(id, status, reviewNote, actorId) {
      const row = await applications.findOneAndUpdate({ id, status: 'pending' }, { $set: { status, reviewNote, reviewedBy: actorId, reviewedAt: new Date() } }, { returnDocument: 'after', projection: publicRow })
      if (!row) throw new HttpError(409, 'Application was already reviewed or not found')
      // Business authorization derives from the approved application; do not overwrite staff/admin roles.
      return row
    },
    async access(id) {
      const user = await users.findOne({ id }, { projection: { role: 1 } })
      if (['admin', 'staff'].includes(user?.role)) return user.role
      return await applications.findOne({ ownerId: id, status: 'approved' }) ? 'business' : 'user'
    },
    posts: (ownerId, offset) => page(posts, ownerId ? { ownerId } : {}, offset),
    async createPost(ownerId, data) {
      const user = await users.findOne({ id: ownerId })
      if (data.premium && !(user?.subscription?.plan === 'plus' && user.subscription.status === 'active')) throw new HttpError(403, 'An active Plus plan is required for premium styling')
      const application = await applications.findOne({ ownerId, status: 'approved' })
      if (!application) throw new HttpError(403, 'A verified business is required')
      const row = { ...data, id: randomUUID(), ...(data.event ? { activityId: randomUUID() } : {}), ownerId, businessName: application.company, status: 'pending', createdAt: new Date() }
      await posts.insertOne(row)
      const { _id, ...result } = row
      return result
    },
    async decidePost(id, status, reviewNote, actorId) {
      const previous = await posts.findOne({ id })
      if (!previous) throw new HttpError(404, 'Post not found')
      const publishing = status === 'approved' && previous.event
      // Revalidate the appointment at review time; an expired event must not enter discovery.
      if (publishing) activityFields({ ...previous.event, startsAt: new Date(previous.event.startsAt).toISOString(), endsAt: new Date(previous.event.endsAt).toISOString(), ...(previous.event.registrationDeadline ? { registrationDeadline: new Date(previous.event.registrationDeadline).toISOString() } : {}) })
      const application = publishing && await applications.findOne({ ownerId: previous.ownerId, status: 'approved' })
      if (publishing && !application) throw new HttpError(403, 'Business verification is required')
      const row = await posts.findOneAndUpdate({ id, status: 'pending' }, { $set: { status: publishing ? 'publishing' : status, reviewNote, reviewedBy: actorId, reviewedAt: new Date() } }, { returnDocument: 'after', projection: publicRow })
      if (!row) throw new HttpError(409, 'Post was already reviewed or not found')
      if (publishing) {
        try {
          const now = new Date()
          await db.collection('activities').updateOne({ id: row.activityId }, { $setOnInsert: {
            ...row.event, id: row.activityId, organizerType: 'business', hostId: row.ownerId, hostName: application.company,
            business: { name: application.company, verified: true, discountPercent: row.discountPercent || 0, offer: row.offer || row.discount || '', terms: row.offerTerms || '' },
            status: 'published', memberCount: 1, reservedSeats: 0, version: 1, tags: ['Doanh nghiệp'], requirements: [],
            scheduleConfirmedAt: now, scheduleConfirmedBy: actorId, createdAt: now, updatedAt: now,
          } }, { upsert: true })
          await posts.updateOne({ id, status: 'publishing' }, { $set: { status: 'approved' } })
          row.status = 'approved'
        } catch (error) {
          // The stable activity ID makes retry safe even if publication was interrupted.
          await posts.updateOne({ id, status: 'publishing' }, { $set: { status: 'pending' } })
          throw error
        }
      }
      return row
    },
    feed: offset => page(posts, { status: 'approved' }, offset, { _id: 0, reviewedBy: 0, reviewNote: 0 }),
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