import { randomUUID } from 'node:crypto'
import { ObjectId } from 'mongodb'
import { HttpError } from '../../common/http-error.js'

const messageView = row => row ? { id: row._id.toHexString(), conversationId: row.conversationId,
  senderId: row.senderId, text: row.text, clientMessageId: row.clientMessageId, createdAt: row.createdAt } : null
const conversationView = row => ({ id: row.id, type: row.type, createdAt: row.createdAt,
  ...(row.type === 'direct' ? { participantIds: row.participantIds } : { activityId: row.activityId }) })

export function createChatRepository(db) {
  const conversations = db.collection('conversations'), messages = db.collection('chat_messages')
  const reads = db.collection('chat_reads'), activities = db.collection('activities')
  const membership = userId => ({ status: { $ne: 'deleted' }, $or: [
    { hostId: userId }, { joinRequests: { $elemMatch: { userId, status: 'approved' } } },
  ] })
  async function access(id, userId) {
    const row = await conversations.findOne({ id })
    if (!row) throw new HttpError(404, 'Conversation not found')
    const allowed = row.type === 'direct' ? row.participantIds.includes(userId)
      : await activities.findOne({ id: row.activityId, ...membership(userId) }, { projection: { _id: 1 } })
    if (!allowed) throw new HttpError(403, 'Conversation access denied')
    return row
  }
  async function summary(row, userId) {
    const read = await reads.findOne({ conversationId: row.id, userId })
    const [last, unreadCount, messageCount] = await Promise.all([
      messages.findOne({ conversationId: row.id }, { sort: { _id: -1 } }),
      messages.countDocuments({ conversationId: row.id, senderId: { $ne: userId },
        ...(read ? { _id: { $gt: read.messageId } } : {}) }),
      messages.countDocuments({ conversationId: row.id }),
    ])
    return { ...conversationView(row), lastMessage: messageView(last), unreadCount, messageCount,
      lastReadMessageId: read?.messageId.toHexString() ?? null }
  }
  return {
    access,
    async create(userId, body) {
      let key, fields
      if (body.type === 'direct') {
        if (body.userId === userId) throw new HttpError(400, 'Cannot create a conversation with yourself')
        if (!await db.collection('users').findOne({ id: body.userId }, { projection: { _id: 1 } })) throw new HttpError(404, 'User not found')
        const participantIds = [userId, body.userId].sort()
        key = `direct:${JSON.stringify(participantIds)}`; fields = { participantIds }
      } else {
        if (!await activities.findOne({ id: body.activityId, ...membership(userId) }, { projection: { _id: 1 } })) throw new HttpError(403, 'Only host and approved members can open activity chat')
        key = `activity:${body.activityId}`; fields = { activityId: body.activityId }
      }
      let row
      try {
        row = await conversations.findOneAndUpdate({ key }, { $setOnInsert: {
          id: randomUUID(), key, type: body.type, ...fields, createdAt: new Date(),
        } }, { upsert: true, returnDocument: 'after' })
      } catch (error) {
        if (error.code !== 11000) throw error
        row = await conversations.findOne({ key })
      }
      return summary(await access(row.id, userId), userId)
    },
    async list(userId, page, limit) {
      // Lookup current activity membership instead of caching a stale group roster.
      const [result] = await conversations.aggregate([
        { $match: { $or: [{ type: 'direct', participantIds: userId }, { type: 'group' }] } },
        { $lookup: { from: 'activities', localField: 'activityId', foreignField: 'id',
          pipeline: [{ $match: membership(userId) }, { $project: { _id: 1 } }], as: 'allowedActivity' } },
        { $match: { $or: [{ type: 'direct' }, { 'allowedActivity.0': { $exists: true } }] } },
        { $sort: { createdAt: -1, id: 1 } },
        { $facet: { items: [{ $skip: (page - 1) * limit }, { $limit: limit }], total: [{ $count: 'count' }] } },
      ], { maxTimeMS: 5000 }).toArray()
      const total = result?.total[0]?.count ?? 0
      const items = await Promise.all((result?.items ?? []).map(row => summary(row, userId)))
      return { items, total, page, limit, hasMore: page * limit < total }
    },
    async snapshot(id, userId) { return summary(await access(id, userId), userId) },
    async history(id, userId, { before, limit }) {
      await access(id, userId)
      const rows = await messages.find({ conversationId: id, ...(before ? { _id: { $lt: new ObjectId(before) } } : {}) })
        .sort({ _id: -1 }).limit(limit + 1).toArray()
      const hasMore = rows.length > limit, items = rows.slice(0, limit).map(messageView)
      return { items, hasMore, nextCursor: hasMore ? items.at(-1).id : null }
    },
    async send(id, userId, { text, clientMessageId }) {
      await access(id, userId)
      let row
      try {
        row = await messages.findOneAndUpdate({ conversationId: id, senderId: userId, clientMessageId }, {
          $setOnInsert: { conversationId: id, senderId: userId, clientMessageId, text, createdAt: new Date() },
        }, { upsert: true, returnDocument: 'after' })
      } catch (error) {
        if (error.code !== 11000) throw error
        row = await messages.findOne({ conversationId: id, senderId: userId, clientMessageId })
      }
      if (row.text !== text) throw new HttpError(409, 'clientMessageId already used for different text')
      return messageView(row)
    },
    async markRead(id, userId, messageId) {
      await access(id, userId)
      const marker = new ObjectId(messageId)
      if (!await messages.findOne({ _id: marker, conversationId: id }, { projection: { _id: 1 } })) throw new HttpError(404, 'Message not found in this conversation')
      const query = { conversationId: id, userId }, update = { $max: { messageId: marker } }
      try { await reads.updateOne(query, update, { upsert: true }) }
      catch (error) { if (error.code !== 11000) throw error; await reads.updateOne(query, update) }
      return summary(await access(id, userId), userId)
    },
  }
}
