import { HttpError } from '../../common/http-error.js'

export function createPostDetails(db, { notify } = {}) {
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
    const now = new Date()
    const nextVersion = version + 1
    const discount = data.discountPercent ? `Giảm ${data.discountPercent}%` : ''
    if (previous.status === 'approved') {
      // Prevent moderation bypass: keep live approved content intact and queue revision for admin review.
      const pendingRevision = { ...data, discount, requestedBy: ownerId, requestedAt: now, version: nextVersion }
      const row = await posts.findOneAndUpdate(
        { id, ownerId, status: 'approved', version: previous.version ?? { $exists: false } },
        {
          $set: { pendingRevision, updatedAt: now },
          $inc: { version: 1 },
          $push: { history: { type: 'details-revision-requested', actorId: ownerId, createdAt: now } },
        },
        { returnDocument: 'after' }
      )
      if (!row) throw new HttpError(409, 'Bài đăng đã thay đổi. Hãy tải lại.')
      if (notify) {
        const admins = await db.collection('users').find({ role: 'admin', deletedAt: { $exists: false } }, { projection: { id: 1 } }).toArray()
        await Promise.all(admins.map(admin => notify(admin.id, `post-revision:${row.id}:${row.version}`, 'Yêu cầu duyệt chỉnh sửa bài đăng', `${row.businessName || 'Doanh nghiệp'} đề xuất sửa bài "${row.title}" → "${data.title}"`, ownerId)))
      }
      const { _id, contentSync, lifecycleTasks, ...result } = row
      return result
    }
    const row = await posts.findOneAndUpdate({ id, ownerId, status: previous.status, version: previous.version ?? { $exists: false } }, {
      $set: { ...data, discount, updatedAt: now },
      $inc: { version: 1 }, $push: { history: { type: 'details-updated', actorId: ownerId, createdAt: now } },
    }, { returnDocument: 'after' })
    if (!row) throw new HttpError(409, 'Bài đăng đã thay đổi. Hãy tải lại.')
    const { _id, contentSync, lifecycleTasks, ...result } = row
    return result
  }
  async function reviewRevision(id, status, reviewNote, actorId, version) {
    if (!['approved', 'rejected'].includes(status)) throw new HttpError(400, 'Trạng thái duyệt không hợp lệ.')
    if (status === 'rejected' && !String(reviewNote || '').trim()) throw new HttpError(400, 'Cần ghi lý do từ chối chỉnh sửa.')
    const previous = await posts.findOne({ id, status: 'approved' })
    if (!previous || !previous.pendingRevision) throw new HttpError(404, 'Không có yêu cầu chỉnh sửa bài đăng đang chờ duyệt.')
    if (version !== undefined && version !== (previous.version ?? 0)) throw new HttpError(409, 'Bài đăng đã thay đổi. Hãy tải lại.')
    const now = new Date()
    const nextVersion = (previous.version ?? 0) + 1
    const cleanNote = String(reviewNote || '').trim().slice(0, 1000)
    const rev = previous.pendingRevision
    const updateDoc = status === 'approved'
      ? {
          $set: {
            title: rev.title,
            copy: rev.copy,
            discountPercent: rev.discountPercent,
            discount: rev.discount || (rev.discountPercent ? `Giảm ${rev.discountPercent}%` : ''),
            offer: rev.offer,
            offerTerms: rev.offerTerms,
            reviewNote: cleanNote,
            reviewedBy: actorId,
            reviewedAt: now,
            updatedAt: now,
            contentSync: { title: rev.title, copy: rev.copy, discountPercent: rev.discountPercent, offer: rev.offer, offerTerms: rev.offerTerms, version: nextVersion },
          },
          $unset: { pendingRevision: '' },
          $inc: { version: 1 },
          $push: { history: { type: 'details-revision-approved', actorId, note: cleanNote, createdAt: now } },
        }
      : {
          $set: { reviewNote: cleanNote, reviewedBy: actorId, reviewedAt: now, updatedAt: now },
          $unset: { pendingRevision: '' },
          $inc: { version: 1 },
          $push: { history: { type: 'details-revision-rejected', actorId, note: cleanNote, createdAt: now } },
        }
    const row = await posts.findOneAndUpdate(
      { id, status: 'approved', version: previous.version ?? { $exists: false }, pendingRevision: { $exists: true } },
      updateDoc,
      { returnDocument: 'after' }
    )
    if (!row) throw new HttpError(409, 'Yêu cầu chỉnh sửa đã được xử lý hoặc bài đăng đã thay đổi.')
    if (status === 'approved') await reconcile(row)
    if (notify) {
      await notify(
        row.ownerId,
        `post-revision-decided:${row.id}:${row.version}`,
        status === 'approved' ? 'Chỉnh sửa bài đăng đã được duyệt' : 'Chỉnh sửa bài đăng bị từ chối',
        cleanNote || row.title,
        actorId
      )
    }
    const { _id, contentSync, lifecycleTasks, ...result } = row
    return result
  }
  async function hydrate(rows) {
    const ids = rows.flatMap(row => (row.groups || []).map(group => group.activityId))
    if (!ids.length) return rows
    const current = new Map((await activities.find({ id: { $in: ids } }, { projection: { id: 1, depositAmount: 1 } }).toArray()).map(row => [row.id, row.depositAmount]))
    return rows.map(row => row.groups ? { ...row, groups: row.groups.map(group => current.has(group.activityId) ? { ...group, depositAmount: current.get(group.activityId) ?? group.depositAmount } : group) } : row)
  }
  return { edit, reviewRevision, reconcile, hydrate }
}
