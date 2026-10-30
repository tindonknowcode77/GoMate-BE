import { randomUUID } from 'node:crypto'
import { HttpError } from '../../common/http-error.js'
import { createActivityRepository } from '../activities/repository.js'
import { createCommunityRepository } from '../community/repository.js'
import { syncActivityMessages } from '../activities/chat-events.js'

export function createPostLifecycle(db) {
  const posts = db.collection('business_posts'), activities = db.collection('activities')
  const repository = createActivityRepository(db), community = createCommunityRepository(db)
  async function applyActivity(task) {
    const { activityId:id, action, actorId } = task
    let settled
    for (let retry = 0; retry < 5; retry++) {
      const row = await activities.findOne({ id })
      if (!row) return
      if (row.status === 'deleted' || action === 'withdraw' && row.businessRevoked) { settled=row; break }
      const event = { id: task.id, type: action === 'delete' ? 'business-group-deleted' : 'business-group-withdrawn', actorId, text: action === 'delete' ? 'Nhóm đã được xóa.' : 'Nhóm đã được thu hồi.', createdAt: new Date() }
      const updated = await repository.lifecycle(row, row.hostId, { status: action === 'delete' ? 'deleted' : 'cancelled', businessRevoked: true, scheduleConfirmedAt: null }, event)
      if (!updated) continue
      settled=updated; break
    }
    if (!settled) throw new HttpError(409, 'Nhóm vừa thay đổi. Vui lòng thử lại.')
    await syncActivityMessages(db, settled)
    await Promise.all((task.recipients || []).map(userId=>community.notify(userId,{key:'business-group-'+action+':'+id,type:'activity',title:action==='delete'?'Nhóm đã được xóa.':'Nhóm đã được thu hồi.',text:settled.title,activityId:id,actorId})))
  }
  async function reconcile(row) {
    const tasks = row.lifecycleTasks || []
    for (const task of tasks) await applyActivity(task)
    // Remove only processed tasks; concurrent lifecycle commands remain queued.
    if (tasks.length) await posts.updateOne({ id: row.id }, { $pull: { lifecycleTasks: { id: { $in: tasks.map(task => task.id) } } } })
  }
  async function command(id, actorId, admin, version, action, groupId) {
    if (!['withdraw', 'delete'].includes(action)) throw new HttpError(400, 'Invalid lifecycle action')
    const previous = await posts.findOne({ id, ...(!admin ? { ownerId: actorId } : {}) })
    if (!previous) throw new HttpError(404, 'Post not found')
    if (previous.status === 'publishing' || version !== (previous.version ?? 0)) throw new HttpError(409, 'Bài đăng đang thay đổi. Vui lòng tải lại.')
    const groups = previous.groups || (previous.activityId ? [{ activityId: previous.activityId }] : [])
    if (groupId && !groups.some(group => group.activityId === groupId)) throw new HttpError(404, 'Group not found')
    if (groupId && !['approved', 'withdrawn', 'deleted'].includes(previous.status)) throw new HttpError(409, 'Chỉ quản lý nhóm sau khi bài đăng đã được duyệt.')
    if (previous.status === 'deleted' && action !== 'delete') throw new HttpError(409, 'Bài đăng đã xóa.')
    const selected = groups.filter(group => !groupId || group.activityId === groupId)
    const tasks = await Promise.all(selected.map(async group => { const row=await activities.findOne({id:group.activityId},{projection:{joinRequests:1}});return {id:randomUUID(),activityId:group.activityId,action,actorId,recipients:(row?.joinRequests || []).filter(member=>['approved','pending'].includes(member.status)).map(member=>member.userId)} }))
    const patch = groupId ? { groups: groups.map(group => group.activityId === groupId ? { ...group, state: action === 'delete' ? 'deleted' : 'withdrawn' } : group) } : { status: action === 'delete' ? 'deleted' : 'withdrawn' }
    if (groupId && patch.groups.every(group => ['withdrawn','deleted'].includes(group.state))) patch.status = 'withdrawn'
    const row = await posts.findOneAndUpdate({ id, version: previous.version ?? { $exists: false }, status: previous.status }, { $set: { ...patch, updatedAt: new Date() }, $inc: { version: 1 }, $push: { history: { type: action, groupId, actorId, createdAt: new Date() }, ...(tasks.length ? { lifecycleTasks: { $each: tasks } } : {}) } }, { returnDocument: 'after' })
    if (!row) throw new HttpError(409, 'Bài đăng vừa thay đổi. Vui lòng tải lại.')
    await reconcile(row)
    const { _id, lifecycleTasks, ...result } = row
    return result
  }
  return { command, reconcile }
}
