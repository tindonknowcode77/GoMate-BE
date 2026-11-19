import { ObjectId } from 'mongodb'
import { HttpError } from '../../common/http-error.js'
import { fields } from './validation.js'
import { adminText } from './admin-validation.js'

const businessView = { _id: 0, id: 1, ownerId: 1, company: 1, status: 1 }
const literalSearch = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function historyQuery(query, messages = false) {
  fields(query, messages ? ['before', 'limit', 'q'] : ['page', 'limit', 'q'])
  const integer = (value, fallback, max) => {
    if (value === undefined) return fallback
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || +value > max) throw new HttpError(400, 'Invalid pagination')
    return +value
  }
  if (query.before !== undefined && (typeof query.before !== 'string' || !/^[a-f0-9]{24}$/.test(query.before))) throw new HttpError(400, 'Invalid message cursor')
  return { ...(!messages ? { page: integer(query.page, 1, 10000) } : { before: query.before }), limit: integer(query.limit, 20, 50), q: adminText(query.q, 'Từ khóa', 120, { optional: true }) }
}

export function createAdminBusinessHistory(db) {
  const businesses = db.collection('business_applications')
  const run = (name, pipeline) => db.collection(name).aggregate(pipeline, { maxTimeMS: 10000 }).toArray()
  const pageResult = (result, page, limit) => ({ items: result.items, total: result.total[0]?.count ?? 0, page, limit, hasMore: page * limit < (result.total[0]?.count ?? 0) })
  const paged = async (name, stages, projection, { page, limit }) => {
    const [result] = await run(name, [...stages, { $facet: { items: [{ $sort: { createdAt: -1, id: 1 } }, { $skip: (page - 1) * limit }, { $limit: limit }, { $project: projection }], total: [{ $count: 'count' }] } }])
    return pageResult(result, page, limit)
  }
  const audit = (business, actorId, resource, context = {}) => db.collection('admin_business_access').insertOne({ businessId: business.id, ownerId: business.ownerId, actorId, resource, ...context, createdAt: new Date() })
  async function business(id) {
    // Retain access to historical/withdrawn business records during an investigation.
    const row = await businesses.findOne({ id }, { projection: businessView })
    if (!row) throw new HttpError(404, 'Không tìm thấy doanh nghiệp')
    if (typeof row.ownerId !== 'string') throw new HttpError(409, 'Hồ sơ thiếu tài khoản doanh nghiệp')
    return row
  }
  async function activityScope(ownerId) {
    const postIds = await db.collection('business_posts').distinct('id', { ownerId })
    return { $or: [{ hostId: ownerId, organizerType: 'business' }, { businessPostId: { $in: postIds } }] }
  }
  async function conversationStages(ownerId) {
    return [
      { $match: { $or: [{ type: 'direct', participantIds: ownerId }, { type: 'group' }] } },
      { $lookup: { from: 'activities', localField: 'activityId', foreignField: 'id', pipeline: [{ $match: await activityScope(ownerId) }, { $project: { _id: 0, title: 1, status: 1 } }], as: 'businessActivity' } },
      { $match: { $or: [{ type: 'direct', participantIds: ownerId }, { 'businessActivity.0': { $exists: true } }] } },
    ]
  }
  return {
    async businessDirectory(options) {
      const filter = options.q ? { company: { $regex: literalSearch(options.q), $options: 'i' } } : {}
      return paged('business_applications', [{ $match: filter }], businessView, options)
    },
    async businessHistory(id, resource, options, actorId) {
      const row = await business(id), { q } = options
      const search = q ? { $regex: literalSearch(q), $options: 'i' } : null
      let result
      if (resource === 'posts') result = await paged('business_posts', [{ $match: { ownerId: row.ownerId, ...(search ? { $or: [{ title: search }, { copy: search }] } : {}) } }], { _id: 0, id: 1, title: 1, copy: 1, status: 1, createdAt: 1, updatedAt: 1, reviewNote: 1, offer: 1, discountPercent: 1, 'history.type': 1, 'history.createdAt': 1, 'groups.name': 1, 'groups.activityId': 1 }, options)
      if (resource === 'activities') result = await paged('activities', [{ $match: { ...await activityScope(row.ownerId), ...(search ? { title: search } : {}) } }], { _id: 0, id: 1, title: 1, businessPostId: 1, status: 1, location: 1, province: 1, district: 1, createdAt: 1, startsAt: 1, endsAt: 1, startedAt: 1, completedAt: 1, cancelledAt: 1, memberCount: 1, 'updates.type': 1, 'updates.createdAt': 1 }, options)
      if (resource === 'conversations') result = await paged('conversations', [
        ...await conversationStages(row.ownerId),
        { $lookup: { from: 'users', localField: 'participantIds', foreignField: 'id', pipeline: [{ $project: { _id: 0, id: 1, name: 1 } }], as: 'participants' } },
        { $set: { title: { $cond: [{ $eq: ['$type', 'group'] }, { $arrayElemAt: ['$businessActivity.title', 0] }, { $reduce: { input: '$participants', initialValue: '', in: { $concat: ['$$value', { $cond: [{ $eq: ['$$value', ''] }, '', ' · '] }, '$$this.name'] } } }] } } },
        ...(search ? [{ $match: { title: search } }] : []),
        { $lookup: { from: 'chat_messages', localField: 'id', foreignField: 'conversationId', pipeline: [{ $count: 'count' }], as: 'messageCounts' } },
        { $set: { messageCount: { $ifNull: [{ $arrayElemAt: ['$messageCounts.count', 0] }, 0] } } },
      ], { _id: 0, id: 1, type: 1, activityId: 1, title: 1, participants: 1, createdAt: 1, messageCount: 1 }, options)
      if (!result) throw new HttpError(404, 'Unknown business history')
      await audit(row, actorId, resource, { page: options.page })
      return { ...result, business: row }
    },
    async businessMessages(id, conversationId, options, actorId) {
      const row = await business(id)
      const allowed = await run('conversations', [{ $match: { id: conversationId } }, ...await conversationStages(row.ownerId), { $project: { _id: 0, id: 1, type: 1, activityId: 1 } }])
      if (!allowed.length) throw new HttpError(404, 'Hội thoại không thuộc doanh nghiệp này')
      const filter = { conversationId, ...(options.before ? { _id: { $lt: new ObjectId(options.before) } } : {}), ...(options.q ? { text: { $regex: literalSearch(options.q), $options: 'i' } } : {}) }
      const messages = await db.collection('chat_messages').find(filter, { projection: { _id: 1, senderId: 1, senderName: 1, kind: 1, text: 1, createdAt: 1, 'attachments.name': 1, 'attachments.kind': 1, 'attachments.mimeType': 1 } }).sort({ _id: -1 }).limit(options.limit + 1).toArray()
      const hasMore = messages.length > options.limit
      const items = messages.slice(0, options.limit).map(({ _id, ...message }) => ({ ...message, id: _id.toHexString() }))
      await audit(row, actorId, 'messages', { conversationId })
      // Reading as Admin neither joins the conversation nor modifies participant read markers.
      return { business: row, conversation: allowed[0], items, hasMore, nextCursor: hasMore ? items.at(-1).id : null }
    },
  }
}
