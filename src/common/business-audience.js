import { createHash } from 'node:crypto'
import { isAssignedStaff, staffGroupScope } from './business-staff-access.js'

export function createBusinessAudience(db) {
  const assignments = db.collection('business_audiences'), activities = db.collection('activities')
  async function choose(userId, postId) {
    const existing = await assignments.findOne({ userId, postId })
    if (existing) return existing.activityId
    const groups = await activities.find({ businessPostId: postId }, { projection: { id: 1, status: 1, businessRevoked: 1, joinRequests: 1 } }).sort({ id: 1 }).toArray()
    const membership = groups.find(row => row.joinRequests?.some(item => item.userId === userId && ['approved', 'pending'].includes(item.status)))
    const available = groups.filter(row => !row.businessRevoked && row.status === 'published')
    if (!membership && !available.length) return null
    const index = available.length ? createHash('sha256').update(userId + ':' + postId).digest().readUInt32BE(0) % available.length : 0
    const activityId = membership?.id || available[index].id
    try {
      const row = await assignments.findOneAndUpdate({ userId, postId }, { $setOnInsert: { userId, postId, activityId, createdAt: new Date() } }, { upsert: true, returnDocument: 'after' })
      return row.activityId
    } catch (error) { if (error.code !== 11000) throw error; return (await assignments.findOne({ userId, postId })).activityId }
  }
  async function canView(row, userId) {
    if (!row.businessPostId || row.hostId === userId) return true
    if (await db.collection('users').findOne({ id: userId, role: 'admin' }, { projection: { id: 1 } }) || await isAssignedStaff(db, userId, row.id)) return true
    const post = await db.collection('business_posts').findOne({ id: row.businessPostId }, { projection: { status: 1, groups: 1 } })
    const member = row.joinRequests?.some(item => item.userId === userId && item.status === 'approved')
    return Boolean((post?.status === 'approved' && !row.businessRevoked && !post.groups?.find(group => group.activityId === row.id)?.state || member && post?.status !== 'deleted') && await choose(userId, row.businessPostId) === row.id)
  }
  async function scope(userId, includeClosed = false) {
    if (includeClosed && await db.collection('users').findOne({ id: userId, role: 'admin' }, { projection: { id: 1 } })) return {}
    const posts = await db.collection('business_posts').find({ status: includeClosed ? { $in: ['approved','withdrawn'] } : 'approved' }, { projection: { id: 1, ownerId: 1, groups: 1 } }).toArray()
    const managed = includeClosed ? await activities.find(await staffGroupScope(db, userId), { projection: { id: 1 } }).toArray() : []
    const saved = new Map((await assignments.find({ userId, postId: { $in: posts.map(post => post.id) } }).toArray()).map(row => [row.postId, row.activityId]))
    const chosen = await Promise.all(posts.filter(post => post.ownerId !== userId).map(async post => { const id = saved.get(post.id) || await choose(userId, post.id); const state = post.groups?.find(group => group.activityId === id)?.state; return state === 'deleted' || state === 'withdrawn' && !includeClosed ? null : id }))
    return { $or: [{ businessPostId: { $exists: false } }, { hostId: userId }, { id: { $in: [...chosen.filter(Boolean), ...managed.map(row => row.id)] }, ...(!includeClosed ? { businessRevoked: { $ne: true } } : {}) }] }
  }
  return { choose, canView, scope }
}
