import { randomUUID } from 'node:crypto'

// Atomic transitions and stable notification keys make concurrent/repeated ticks safe.
export function createActivityScheduler(db, community) {
  const activities = db.collection('activities')
  let running
  async function notifyMembers(row, kind, title, text) {
    const recipients = new Set([row.hostId, ...(row.joinRequests ?? []).filter(member => member.status === 'approved').map(member => member.userId)])
    await Promise.all([...recipients].map(userId => community.notifyScheduled(userId, {
      key: `activity:${row.id}:${kind}:${new Date(kind === 'reminder' ? row.startsAt : row.endsAt).toISOString()}`,
      type: 'activity', title, text, activityId: row.id,
    })))
  }
  async function process(now) {
    const overdue = await activities.find({ status: { $in: ['published', 'in-progress'] }, endsAt: { $lte: now } }).limit(100).toArray()
    for (const row of overdue) {
      const expired = row.status === 'published'
      const entry = { id: randomUUID(), type: expired ? 'expired' : 'completed', text: expired ? 'Hoạt động hết hạn mà chưa bắt đầu.' : 'Hoạt động tự kết thúc vì đã hết thời gian.', createdAt: now }
      await activities.updateOne({ id: row.id, status: row.status, version: row.version ?? { $exists: false }, endsAt: row.endsAt }, {
        $set: { status: expired ? 'expired' : 'completed', ...(expired ? { expiredAt: row.endsAt } : { completedAt: row.endsAt }), autoCompletedAt: now, updatedAt: now },
        $push: { updates: entry }, $inc: { version: 1 },
      })
    }
    const completed = await activities.find({ status: { $in: ['completed', 'expired'] }, autoCompletedAt: { $exists: true }, autoCompletionNotified: { $ne: true } }).limit(100).toArray()
    for (const row of completed) {
      await notifyMembers(row, 'completed', row.status === 'expired' ? 'Hoạt động đã hết hạn' : 'Hoạt động đã kết thúc', row.status === 'expired' ? `${row.title} đã hết hạn mà chưa bắt đầu; không mở đánh giá.` : `${row.title} đã tự kết thúc theo lịch. Bạn có thể xem tổng kết trong nhóm.`)
      await activities.updateOne({ id: row.id, status: row.status }, { $set: { autoCompletionNotified: true } })
    }
    const upcoming = await activities.find({ status: 'published', startsAt: { $gt: now, $lte: new Date(+now + 30 * 60000) } }).toArray()
    for (const row of upcoming) await notifyMembers(row, 'reminder', 'Nhắc lịch hoạt động', `${row.title} sẽ bắt đầu trong 30 phút tới. Hãy kiểm tra thời gian và điểm hẹn trong nhóm.`)
  }
  return {
    tick(now = new Date()) {
      if (running) return running
      running = process(now).finally(() => { running = undefined })
      return running
    },
  }
}
