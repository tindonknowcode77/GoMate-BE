import { createBusinessAudience } from '../../common/business-audience.js'
import { realtimeEvents } from '../../common/realtime-events.js'
import { syncActivityMessages } from '../activities/chat-events.js'
import { randomUUID } from 'node:crypto'
import { messageLinks } from './content.js'
import { ObjectId, Binary } from 'mongodb'
import { HttpError } from '../../common/http-error.js'
import { createCommunityRepository } from '../community/repository.js'
import { isAssignedStaff, listAssignedStaff, staffGroupScope } from '../../common/business-staff-access.js'

const messageView = row => row ? { id: row._id.toHexString(), conversationId: row.conversationId,
  kind: row.kind || 'message', eventId: row.eventId, senderId: row.senderId, senderName: row.senderName ?? 'Thành viên', text: row.text, attachments: row.attachments ?? [], location: row.location ?? null, links: row.links ?? messageLinks(row.text), clientMessageId: row.clientMessageId, createdAt: row.createdAt } : null
const conversationView = row => ({ id: row.id, type: row.type, createdAt: row.createdAt,
  ...(row.type === 'direct' ? { participantIds: row.participantIds } : { activityId: row.activityId }) })

export function createChatRepository(db) {
  const events = realtimeEvents(db)
  const community = createCommunityRepository(db)
  const audience = createBusinessAudience(db)
  const conversations = db.collection('conversations'), messages = db.collection('chat_messages')
  const uploads = db.collection('chat_attachments')
  const attachmentView = row => ({ id: row._id.toHexString(), name: row.name, size: row.size, mimeType: row.mimeType, kind: row.kind })
  const reads = db.collection('chat_reads'), activities = db.collection('activities')
  async function membership(userId) {
    return { $and: [await audience.scope(userId, true)], status: { $nin: ['deleted', 'pending-review'] }, $or: [{ hostId: userId }, { joinRequests: { $elemMatch: { userId, status: 'approved' } } }, await staffGroupScope(db, userId)] }
  }
  async function access(id, userId) {
    const row = await conversations.findOne({ id })
    if (!row) throw new HttpError(404, 'Conversation not found')
    // A known conversation needs only its own group's access check, not a scan
    // of every campaign and assignment belonging to this user.
    const group = row.type === 'group' ? await activities.findOne({ id: row.activityId, status: { $nin: ['deleted', 'pending-review'] } }, { projection: { id: 1, hostId: 1, hostName: 1, joinRequests: 1, businessPostId: 1, businessRevoked: 1, status: 1, updates: 1, createdAt: 1 } }) : null
    const allowed = row.type === 'direct' ? row.participantIds.includes(userId)
      : group && (group.hostId === userId || group.joinRequests?.some(item => item.userId === userId && item.status === 'approved') || await isAssignedStaff(db, userId, group.id)) && await audience.canView(group, userId)
    if (!allowed) throw new HttpError(403, 'Conversation access denied')
    if (row.type === 'direct') {
      const otherId = row.participantIds.find(id => id !== userId)
      if (await community.blocked(userId, otherId)) throw new HttpError(403, 'Không thể nhắn tin với tài khoản đã chặn')
    }
    if (group) await syncActivityMessages(db, group)
    return row
  }
  async function summaries(rows, userId) {
    if (!rows.length) return []
    const ids = rows.map(row => row.id)
    const markers = await reads.find({ conversationId: { $in: ids }, userId }).toArray()
    const threshold = { $switch: { branches: [{ case: false, then: null }, ...markers.map(read => ({ case: { $eq: ['$conversationId', read.conversationId] }, then: read.messageId }))], default: new ObjectId('000000000000000000000000') } }
    // A single grouped scan replaces per-conversation counts and last-message reads.
    const [stats, groups, people] = await Promise.all([
      messages.aggregate([{ $match: { conversationId: { $in: ids } } }, { $sort: { conversationId: 1, _id: -1 } }, { $group: { _id: '$conversationId', last: { $first: '$$ROOT' }, messageCount: { $sum: 1 }, unreadCount: { $sum: { $cond: [{ $and: [{ $ne: ['$senderId', userId] }, { $gt: ['$_id', threshold] }] }, 1, 0] } } } }]).toArray(),
      activities.find({ id: { $in: rows.filter(row => row.type === 'group').map(row => row.activityId) } }, { projection: { id: 1, title: 1, hostId: 1, imageUrl: 1, memberCount: 1, status: 1, startsAt: 1, scheduleConfirmedAt: 1 } }).toArray(),
      db.collection('users').find({ id: { $in: rows.filter(row => row.type === 'direct').flatMap(row => row.participantIds.filter(id => id !== userId)) } }, { projection: { id: 1, name: 1, avatar_url: 1 } }).toArray(),
    ])
    const byId = new Map(stats.map(row => [row._id, row])), byGroup = new Map(groups.map(row => [row.id, row])), byUser = new Map(people.map(row => [row.id, row])), byRead = new Map(markers.map(row => [row.conversationId, row]))
    return rows.map(row => {
      const stat = byId.get(row.id), activity = byGroup.get(row.activityId), other = byUser.get(row.participantIds?.find(id => id !== userId))
      return { ...conversationView(row), name: activity?.title ? `Nhóm ${activity.title}` : other?.name ?? 'Cuộc trò chuyện', activityTitle: activity?.title ?? '', lastMessage: messageView(stat?.last), unreadCount: stat?.unreadCount ?? 0, messageCount: stat?.messageCount ?? 0,
        avatarUrl: activity?.imageUrl ?? other?.avatar_url ?? null,
        ...(activity ? { hostId: activity.hostId, memberCount: activity.memberCount, activityStatus: activity.status, startsAt: activity.startsAt, scheduleConfirmedAt: activity.scheduleConfirmedAt ?? null } : {}),
        lastReadMessageId: byRead.get(row.id)?.messageId.toHexString() ?? null }
    })
  }
  async function summary(row, userId) { return (await summaries([row], userId))[0] }
  return {
    events,
    access,
    async upload(id, userId, file, metadata) {
      await access(id, userId)
      const size = await uploads.aggregate([{ $match: { conversationId: id, ownerId: userId } }, { $group: { _id: null, total: { $sum: '$size' } } }]).toArray()
      if ((size[0]?.total ?? 0) + file.length > 250 * 1024 * 1024) throw new HttpError(413, 'Giới hạn lưu trữ 250 MB trong mỗi cuộc trò chuyện')
      const row = { _id: new ObjectId(), conversationId: id, ownerId: userId, ...metadata, data: new Binary(file), expiresAt: new Date(Date.now() + 86400000), createdAt: new Date() }
      await uploads.insertOne(row)
      return attachmentView(row)
    },
    async attachment(id, userId, attachmentId) {
      await access(id, userId)
      const row = await uploads.findOne({ _id: new ObjectId(attachmentId), conversationId: id })
      if (!row || (!row.messageId && row.ownerId !== userId)) throw new HttpError(404, 'Attachment not found')
      return row
    },
    async shared(id, userId, { kind, before, limit }) {
      await access(id, userId)
      const condition = kind === 'media' ? { 'attachments.kind': { $in: ['image', 'video', 'audio'] } } : kind === 'files' ? { 'attachments.kind': 'file' } : kind === 'locations' ? { location: { $ne: null } } : { $or: [{ 'links.0': { $exists: true } }, { text: { $regex: 'https?://', $options: 'i' } }] }
      const rows = await messages.find({ conversationId: id, ...condition, ...(before ? { _id: { $lt: new ObjectId(before) } } : {}) }).sort({ _id: -1 }).limit(limit + 1).toArray()
      const items = rows.slice(0, limit).map(messageView)
      return { items, hasMore: rows.length > limit, nextCursor: rows.length > limit ? items.at(-1).id : null }
    },
    async create(userId, body) {
      let key, fields
      if (body.type === 'direct') {
        if (body.userId === userId) throw new HttpError(400, 'Cannot create a conversation with yourself')
        if (!await db.collection('users').findOne({ id: body.userId }, { projection: { _id: 1 } })) throw new HttpError(404, 'User not found')
        if (await community.blocked(userId, body.userId)) throw new HttpError(403, 'Không thể nhắn tin với tài khoản đã chặn')
        if ((await community.settings(body.userId)).directMessages === 'friends' && !await db.collection('friendships').findOne({ key: JSON.stringify([userId, body.userId].sort()), status: 'accepted' })) throw new HttpError(403, 'Người này chỉ nhận tin nhắn từ bạn bè')
        const participantIds = [userId, body.userId].sort()
        key = `direct:${JSON.stringify(participantIds)}`; fields = { participantIds }
      } else {
        if (!await activities.findOne({ id: body.activityId, ...await membership(userId) }, { projection: { _id: 1 } })) throw new HttpError(403, 'Only host and approved members can open activity chat')
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
    async list(userId, page, limit, filters = {}) {
      // Existing approved grants also gain a visible chat without a manual open.
      const assignedGroups = filters.type === 'direct' ? [] : await activities.find(await membership(userId), { projection: { id: 1, title: 1, hostId: 1, hostName: 1, createdAt: 1, updates: 1 } }).toArray()
      const existing = new Set((await conversations.find({ activityId: { $in: assignedGroups.map(row => row.id) } }, { projection: { activityId: 1 } }).toArray()).map(row => row.activityId))
      for (const group of assignedGroups) {
        if (!existing.has(group.id)) try {
          await conversations.updateOne({ key: `activity:${group.id}` }, { $setOnInsert: { id: randomUUID(), key: `activity:${group.id}`, type: 'group', activityId: group.id, createdAt: new Date() } }, { upsert: true })
        } catch (error) { if (error.code !== 11000) throw error }
        if (group.updates?.length) await syncActivityMessages(db, group)
      }
      const excluded = await community.blockedIds(userId)
      const literal = filters.q?.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const names = literal ? await db.collection('users').find({ id: { $ne: userId }, name: { $regex: literal, $options: 'i' } }, { projection: { id: 1 } }).toArray() : []
      const titlePattern = literal ? new RegExp(literal, 'i') : null
      const filterStages = [
        ...(filters.type ? [{ $match: { type: filters.type } }] : []),
        ...(literal ? [{ $match: { $or: [{ type: 'group', activityId: { $in: assignedGroups.filter(row => titlePattern.test(row.title ?? '')).map(row => row.id) } }, { type: 'direct', participantIds: { $in: names.map(row => row.id) } }, { 'latestMessage.text': { $regex: literal, $options: 'i' } }] } }] : []),
        ...(filters.unread ? [
          { $lookup: { from: 'chat_reads', localField: 'id', foreignField: 'conversationId', pipeline: [{ $match: { userId } }, { $project: { messageId: 1 } }], as: 'readMarker' } },
          { $lookup: { from: 'chat_messages', localField: 'id', foreignField: 'conversationId', let: { marker: { $ifNull: [{ $arrayElemAt: ['$readMarker.messageId', 0] }, new ObjectId('000000000000000000000000')] } }, pipeline: [{ $match: { senderId: { $ne: userId }, $expr: { $gt: ['$_id', '$$marker'] } } }, { $limit: 1 }, { $project: { _id: 1 } }], as: 'unreadMessage' } },
          { $match: { 'unreadMessage.0': { $exists: true } } },
        ] : []),
      ]
      // Membership is computed once; do not join every group conversation globally.
      const [result] = await conversations.aggregate([
        { $match: { $or: [{ type: 'direct', $and: [{ participantIds: userId }, { participantIds: { $nin: excluded } }] }, { type: 'group', activityId: { $in: assignedGroups.map(row => row.id) } }] } },
        { $lookup: { from: 'chat_messages', localField: 'id', foreignField: 'conversationId', pipeline: [{ $sort: { _id: -1 } }, { $limit: 1 }, { $project: { createdAt: 1, text: 1 } }], as: 'latestMessage' } },
        ...filterStages,
        { $set: { lastActivityAt: { $ifNull: [{ $arrayElemAt: ['$latestMessage.createdAt', 0] }, '$createdAt'] } } },
        { $sort: { lastActivityAt: -1, id: 1 } },
        { $facet: { items: [{ $skip: (page - 1) * limit }, { $limit: limit }], total: [{ $count: 'count' }] } },
      ], { maxTimeMS: 5000 }).toArray()
      const total = result?.total[0]?.count ?? 0
      const items = await summaries(result?.items ?? [], userId)
      return { items, total, page, limit, hasMore: page * limit < total }
    },
    async unreadCount(userId) {
      const [groups, excluded] = await Promise.all([activities.find(await membership(userId), { projection: { id: 1 } }).toArray(), community.blockedIds(userId)])
      const rows = await conversations.find({ $or: [{ type: 'direct', $and: [{ participantIds: userId }, { participantIds: { $nin: excluded } }] }, { type: 'group', activityId: { $in: groups.map(row => row.id) } }] }, { projection: { id: 1 } }).toArray()
      if (!rows.length) return 0
      const ids = rows.map(row => row.id), markers = await reads.find({ userId, conversationId: { $in: ids } }).toArray()
      const threshold = { $switch: { branches: [{ case: false, then: null }, ...markers.map(read => ({ case: { $eq: ['$conversationId', read.conversationId] }, then: read.messageId }))], default: new ObjectId('000000000000000000000000') } }
      const [count] = await messages.aggregate([{ $match: { conversationId: { $in: ids }, senderId: { $ne: userId }, $expr: { $gt: ['$_id', threshold] } } }, { $count: 'value' }]).toArray()
      return count?.value ?? 0
    },
    async snapshot(id, userId) { return summary(await access(id, userId), userId) },
    async history(id, userId, { before, after, limit }) {
      await access(id, userId)
      const rows = await messages.find({ conversationId: id, ...(before ? { _id: { $lt: new ObjectId(before) } } : after ? { _id: { $gt: new ObjectId(after) } } : {}) })
        .sort({ _id: after ? 1 : -1 }).limit(limit + 1).toArray()
      const hasMore = rows.length > limit, items = rows.slice(0, limit).map(messageView)
      return { items, hasMore, nextCursor: hasMore ? items.at(-1).id : null }
    },
    async send(id, userId, { text, clientMessageId, attachmentIds = [], location = null }) {
      const target = await access(id, userId)
      const group = target.type === 'group' ? await activities.findOne({ id: target.activityId }, { projection: { planFileData: 0 } }) : null
      if (group?.status === 'cancelled') throw new HttpError(409, 'Hoạt động đã hủy. Bạn vẫn có thể xem lịch sử trò chuyện.', 'ACTIVITY_CANCELLED')
      if (target.type === 'direct') {
        const otherId = target.participantIds.find(id => id !== userId)
        if ((await community.settings(otherId)).directMessages === 'friends' && !await db.collection('friendships').findOne({ key: JSON.stringify([userId, otherId].sort()), status: 'accepted' })) throw new HttpError(403, 'Người này chỉ nhận tin nhắn từ bạn bè')
      }
      const files = await Promise.all(attachmentIds.map(async fileId => {
        const file = await uploads.findOne({ _id: new ObjectId(fileId), conversationId: id, ownerId: userId }, { projection: { data: 0 } })
        if (!file) throw new HttpError(400, 'Invalid attachment')
        return attachmentView(file)
      }))
      const sender = await db.collection('users').findOne({ id: userId }, { projection: { name: 1 } })
      let row
      try {
        row = await messages.findOneAndUpdate({ conversationId: id, senderId: userId, clientMessageId }, {
          $setOnInsert: { conversationId: id, senderId: userId, senderName: sender?.name ?? 'Thành viên', clientMessageId, text, attachments: files, location, links: messageLinks(text), createdAt: new Date() },
        }, { upsert: true, returnDocument: 'after' })
      } catch (error) {
        if (error.code !== 11000) throw error
        row = await messages.findOne({ conversationId: id, senderId: userId, clientMessageId })
      }
      if (row.text !== text || JSON.stringify(row.attachments ?? []) !== JSON.stringify(files) || JSON.stringify(row.location ?? null) !== JSON.stringify(location)) throw new HttpError(409, 'clientMessageId already used for different text')
      if (attachmentIds.length) await uploads.updateMany({ _id: { $in: attachmentIds.map(value => new ObjectId(value)) }, conversationId: id, ownerId: userId }, { $set: { messageId: row._id, clientMessageId }, $unset: { expiresAt: '' } })
      const recipients = group ? [...new Set([group.hostId, ...(group.joinRequests ?? []).filter(item => item.status === 'approved').map(item => item.userId), ...(await listAssignedStaff(db, group)).map(item => item.userId)])] : target.participantIds
      await Promise.all(recipients.map(recipient => community.notify(recipient, { key: `message:${row._id}`, type: 'message', title: group?.title || sender?.name || 'Tin nhắn mới', text: (text || (location ? 'Đã chia sẻ vị trí' : 'Đã gửi tệp đính kèm')).slice(0, 160), conversationId: id, activityId: group?.id, actorId: userId })))
      const view = messageView(row)
      events.emit('conversation', id, { message: view })
      for (const recipient of new Set(recipients)) events.emit('user', recipient)
      return view
    },
    async markRead(id, userId, messageId) {
      await access(id, userId)
      const marker = new ObjectId(messageId)
      const message = await messages.findOne({ _id: marker, conversationId: id }, { projection: { _id: 1, createdAt: 1 } })
      if (!message) throw new HttpError(404, 'Message not found in this conversation')
      const query = { conversationId: id, userId }, update = { $max: { messageId: marker } }
      try { await reads.updateOne(query, update, { upsert: true }) }
      catch (error) { if (error.code !== 11000) throw error; await reads.updateOne(query, update) }
      await db.collection('notifications').updateMany({ userId, conversationId: id, type: 'message', readAt: null, key: { $lte: `message:${messageId}` } }, { $set: { readAt: new Date() } })
      events.emit('conversation', id)
      events.emit('user', userId)
      return summary(await access(id, userId), userId)
    },
  }
}
