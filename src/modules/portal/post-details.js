import { HttpError } from '../../common/http-error.js'

export function createPostDetails(db) {
  const posts = db.collection('business_posts'), activities = db.collection('activities')
  async function reconcile(row) {
    const task = row.contentSync
    if (!task) return
    const patch = { title: task.title, businessCampaignTitle: task.title, description: task.copy, 'business.discountPercent': task.discountPercent, 'business.offer': task.offer, 'business.terms': task.offerTerms, businessContentVersion: task.version, updatedAt: new Date() }
    // Revision ordering makes retries safe, even when two edits sync concurrently.
    await activities.updateMany({ businessPostId: row.id, status: { $ne: 'deleted' }, $or: [{ businessContentVersion: { $exists: false } }, { businessContentVersion: { $lt: task.version } }] }, { $set: patch, $inc: { version: 1 } })
    await posts.updateOne({ id: row.id, 'contentSync.version': task.version }, { $unset: { contentSync: '' } })
  }
  async function edit(id, ownerId, version, data) {
    const previous = await posts.findOne({ id, ownerId })
    if (!previous) throw new HttpError(404, 'Post not found')
    if (!['approved', 'pending', 'rejected'].includes(previous.status) || version !== (previous.version ?? 0)) throw new HttpError(409, 'Bài đăng đã thay đổi hoặc không còn chỉnh sửa được. Hãy tải lại.')
    const nextVersion = version + 1
    const row = await posts.findOneAndUpdate({ id, ownerId, status: previous.status, version: previous.version ?? { $exists: false } }, {
      $set: { ...data, discount: data.discountPercent ? `Giảm ${data.discountPercent}%` : '', updatedAt: new Date(), ...(previous.status === 'approved' ? { contentSync: { ...data, version: nextVersion } } : {}) },
      $inc: { version: 1 }, $push: { history: { type: 'details-updated', actorId: ownerId, createdAt: new Date() } },
    }, { returnDocument: 'after' })
    if (!row) throw new HttpError(409, 'Bài đăng đã thay đổi. Hãy tải lại.')
    await reconcile(row)
    const { _id, contentSync, lifecycleTasks, ...result } = row
    return result
  }
  async function hydrate(rows) {
    const ids = rows.flatMap(row => (row.groups || []).map(group => group.activityId))
    if (!ids.length) return rows
    const current = new Map((await activities.find({ id: { $in: ids } }, { projection: { id: 1, depositAmount: 1 } }).toArray()).map(row => [row.id, row.depositAmount]))
    return rows.map(row => row.groups ? { ...row, groups: row.groups.map(group => current.has(group.activityId) ? { ...group, depositAmount: current.get(group.activityId) ?? group.depositAmount } : group) } : row)
  }
  return { edit, reconcile, hydrate }
}
