import { randomUUID } from 'node:crypto'
import { HttpError } from '../../common/http-error.js'

export const defaultSettings = {
  allowFriendRequests: true, directMessages: 'everyone', discoverable: true,
  notifyActivity: true, notifyMessages: true, notifyFriends: true,
}
export function createCommunityRepository(db) {
  const users = db.collection('users'), notices = db.collection('notifications'), blocks = db.collection('user_blocks')
  const pair = (a, b) => ({ $or: [{ ownerId: a, targetId: b }, { ownerId: b, targetId: a }] })
  const blocked = async (a, b) => Boolean(await blocks.findOne(pair(a, b)))
  async function blockedIds(id) { return (await blocks.find({ $or: [{ ownerId: id }, { targetId: id }] }).toArray()).map(row => row.ownerId === id ? row.targetId : row.ownerId) }
  async function settings(id) { return { ...defaultSettings, ...(await users.findOne({ id }, { projection: { settings: 1 } }))?.settings } }
  async function notify(userId, { key, type, title, text, activityId, conversationId, actorId }) {
    if (actorId === userId || actorId && await blocked(userId, actorId)) return
    const prefs = await settings(userId)
    if (!(type === 'message' ? prefs.notifyMessages : type.startsWith('friend') ? prefs.notifyFriends : prefs.notifyActivity)) return
    try { await notices.updateOne({ userId, key }, { $setOnInsert: { id: randomUUID(), userId, key, type, title, text, activityId, conversationId, actorId, createdAt: new Date(), readAt: null } }, { upsert: true }) }
    catch (error) { if (error.code !== 11000) throw error }
    if (type === 'message' && conversationId) {
      const read = await db.collection('chat_reads').findOne({ userId, conversationId })
      if (read && read.messageId.toHexString() >= key.slice('message:'.length)) await notices.updateOne({ userId, key, readAt: null }, { $set: { readAt: new Date() } })
    }
  }
  async function activity(id, userId) {
    const row = await db.collection('activities').findOne({ id, status: { $ne: 'deleted' } })
    if (!row || row.hostId !== userId && !row.joinRequests?.some(member => member.userId === userId && member.status === 'approved')) throw new HttpError(403, 'Chỉ thành viên của hoạt động có quyền truy cập')
    return row
  }
  return {
    blocked, blockedIds, settings,
    async notify(...args) { try { await notify(...args) } catch { console.warn('Notification storage failed; primary action was preserved') } },
    async saveSettings(id, values) { await users.updateOne({ id }, { $set: Object.fromEntries(Object.entries(values).map(([key, value]) => [`settings.${key}`, value])) }); return settings(id) },
    async notifications(id, page, limit) {
      const excluded = await blockedIds(id), query = { userId: id, actorId: { $nin: excluded } }
      const [items, total, unreadCount] = await Promise.all([notices.find(query, { projection: { _id: 0, userId: 0, key: 0 } }).sort({ createdAt: -1, id: -1 }).skip((page - 1) * limit).limit(limit).toArray(), notices.countDocuments(query), notices.countDocuments({ ...query, readAt: null })])
      return { items, total, unreadCount, page, limit, hasMore: page * limit < total }
    },
    async readNotice(userId, id) {
      const query = { userId, ...(id ? { id } : {}) }
      if (id && !await notices.findOne(query)) throw new HttpError(404, 'Không tìm thấy thông báo')
      await notices.updateMany({ ...query, readAt: null }, { $set: { readAt: new Date() } })
    },
    async listBlocks(ownerId) {
      const rows = await blocks.find({ ownerId }).sort({ createdAt: -1 }).toArray()
      const people = await users.find({ id: { $in: rows.map(row => row.targetId) } }, { projection: { id: 1, name: 1, avatar_url: 1 } }).toArray()
      return rows.map(row => ({ userId: row.targetId, name: people.find(user => user.id === row.targetId)?.name || 'Người dùng', avatarUrl: people.find(user => user.id === row.targetId)?.avatar_url ?? null, createdAt: row.createdAt }))
    },
    async block(ownerId, targetId) {
      if (ownerId === targetId || !await users.findOne({ id: targetId })) throw new HttpError(400, 'Chọn tài khoản khác để chặn')
      await blocks.updateOne({ ownerId, targetId }, { $setOnInsert: { ownerId, targetId, createdAt: new Date() } }, { upsert: true })
      await db.collection('friendships').deleteOne({ key: JSON.stringify([ownerId, targetId].sort()) })
    },
    async unblock(ownerId, targetId) { await blocks.deleteOne({ ownerId, targetId }) },
    async report(userId, body) {
      const row = await db.collection('activities').findOne({ id: body.activityId, status: { $ne: 'deleted' } }, { projection: { hostId: 1 } })
      if (!row) throw new HttpError(404, 'Hoạt động không còn tồn tại')
      if (row.hostId === userId) throw new HttpError(400, 'Không thể báo cáo bài đăng của chính bạn')
      const reports = db.collection('reports'), key = `${userId}:${body.activityId}`
      let report
      try { report = await reports.findOneAndUpdate({ key }, { $setOnInsert: { id: randomUUID(), key, reporterId: userId, ...body, status: 'pending', createdAt: new Date() } }, { upsert: true, returnDocument: 'after' }) }
      catch (error) { if (error.code !== 11000) throw error; report = await reports.findOne({ key }) }
      return { id: report.id, activityId: report.activityId, reason: report.reason, detail: report.detail, status: report.status, createdAt: report.createdAt }
    },
    async reports(userId) { return db.collection('reports').find({ reporterId: userId }, { projection: { _id: 0, id: 1, activityId: 1, reason: 1, detail: 1, status: 1, createdAt: 1, resolvedAt: 1 } }).sort({ createdAt: -1 }).limit(100).toArray() },
    async ratingForm(activityId, userId) {
      const row = await activity(activityId, userId)
      if (row.status !== 'completed') throw new HttpError(409, 'Chỉ đánh giá sau khi hoạt động kết thúc')
      const attended = new Set((row.attendance ?? []).filter(member => ['present', 'late'].includes(member.status)).map(member => member.userId))
      if (!attended.has(userId)) throw new HttpError(403, 'Bạn cần được host điểm danh có mặt hoặc đến muộn để đánh giá')
      const ids = [row.hostId, ...(row.joinRequests ?? []).filter(member => member.status === 'approved').map(member => member.userId)].filter(id => id !== userId && attended.has(id))
      const people = await users.find({ id: { $in: ids } }, { projection: { _id: 0, id: 1, name: 1, avatar_url: 1 } }).toArray()
      const submitted = await db.collection('rating_submissions').findOne({ activityId, userId }, { projection: { _id: 0, activityId: 0, userId: 0 } })
      return { activityId, title: row.title, members: people.map(person => ({ id: person.id, name: person.name, avatarUrl: person.avatar_url ?? null })), submitted }
    },
    async rate(activityId, userId, body) {
      const form = await this.ratingForm(activityId, userId)
      if (body.members.some(item => !form.members.some(member => member.id === item.userId))) throw new HttpError(400, 'Chỉ đánh giá người cùng tham gia hoạt động')
      const submissions = db.collection('rating_submissions')
      const existing = await submissions.findOne({ activityId, userId })
      if (existing && JSON.stringify(existing.value) !== JSON.stringify(body)) throw new HttpError(409, 'Bạn đã gửi đánh giá cho hoạt động này')
      const value = existing ?? { activityId, userId, value: body, createdAt: new Date() }
      if (!existing) { try { await submissions.insertOne(value) } catch (error) { if (error.code !== 11000) throw error; return this.rate(activityId, userId, body) } }
      // Idempotent writes also repair an interrupted request after submission was stored.
      for (const item of body.members) {
        const key = { activityId, authorId: userId, targetUserId: item.userId }
        try { await db.collection('activity_ratings').updateOne(key, { $setOnInsert: { ...key, id: randomUUID(), score: item.score, comment: body.comment, activityTitle: form.title, createdAt: value.createdAt } }, { upsert: true }) }
        catch (error) { if (error.code !== 11000) throw error }
      }
      return { submitted: { value: body, createdAt: value.createdAt } }
    },
    async reputation(userId) {
      const [rating, completed] = await Promise.all([db.collection('activity_ratings').aggregate([{ $match: { targetUserId: userId, score: { $gte: 1, $lte: 5 } } }, { $group: { _id: null, average: { $avg: '$score' }, count: { $sum: 1 } } }]).toArray(), db.collection('activities').countDocuments({ hostId: userId, status: 'completed' })])
      return { average: rating[0]?.average ?? null, count: rating[0]?.count ?? 0, completedActivities: completed }
    },
    async moderationQueue() { return db.collection('reports').find({}, { projection: { _id: 0, key: 0 } }).sort({ createdAt: -1 }).limit(200).toArray() },
    async moderate(id, actorId, status, hideActivity) {
      let row = await db.collection('reports').findOneAndUpdate({ id, status: 'pending' }, { $set: { status, hideActivity, resolvedBy: actorId, resolvedAt: new Date() } }, { returnDocument: 'after' })
      if (!row) row = await db.collection('reports').findOne({ id, status, hideActivity, resolvedBy: actorId })
      if (!row) throw new HttpError(409, 'Báo cáo đã được xử lý hoặc không tồn tại')
      if (hideActivity) await db.collection('activities').updateOne({ id: row.activityId, status: { $ne: 'deleted' } }, { $set: { status: 'deleted', moderatedBy: actorId, deletedAt: new Date() }, $inc: { version: 1 } })
      await this.notify(row.reporterId, { key: `report:${row.id}`, type: 'activity', title: 'Báo cáo đã được xem xét', text: status === 'resolved' ? 'GoMate đã xử lý báo cáo của bạn.' : 'GoMate đã xem xét báo cáo của bạn.', activityId: row.activityId })
      return { id: row.id, status }
    },
  }
}
