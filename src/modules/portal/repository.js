import { randomUUID } from 'node:crypto'
import { HttpError } from '../../common/http-error.js'

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
      const row = { ...data, id: randomUUID(), ownerId, businessName: application?.company || user.name, status: 'pending', createdAt: new Date() }
      await posts.insertOne(row)
      const { _id, ...result } = row
      return result
    },
    async decidePost(id, status, reviewNote, actorId) {
      const row = await posts.findOneAndUpdate({ id, status: 'pending' }, { $set: { status, reviewNote, reviewedBy: actorId, reviewedAt: new Date() } }, { returnDocument: 'after', projection: publicRow })
      if (!row) throw new HttpError(409, 'Post was already reviewed or not found')
      return row
    },
    feed: offset => page(posts, { status: 'approved' }, offset, { _id: 0, reviewedBy: 0, reviewNote: 0 }),
    users: offset => page(users, {}, offset, { _id: 0, id: 1, name: 1, email: 1, role: 1, subscription: 1, created_at: 1 }),
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
      return { users: await users.countDocuments(), pendingBusinesses: await applications.countDocuments({ status: 'pending' }), pendingPosts: await posts.countDocuments({ status: 'pending' }), openTickets: await tickets.countDocuments({ status: 'open' }), openReports: await db.collection('reports').countDocuments({ status: 'pending' }) }
    },
  }
}
