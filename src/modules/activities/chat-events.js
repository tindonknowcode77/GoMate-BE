import { randomUUID } from 'node:crypto'
import { realtimeEvents } from '../../common/realtime-events.js'
import { listAssignedStaff } from '../../common/business-staff-access.js'

const labels = {
  'business-group-withdrawn': 'Nhóm đã được thu hồi.', 'business-group-deleted': 'Nhóm đã được xóa.',
  'schedule-confirmed': 'Đã chốt lịch hoạt động', started: 'Hoạt động đã bắt đầu', completed: 'Hoạt động đã kết thúc',
  expired: 'Hoạt động đã hết hạn', cancelled: 'Hoạt động đã bị hủy', 'plan-updated': 'Kế hoạch đã được cập nhật',
  'business-plan-updated': 'Kế hoạch đã được cập nhật', 'activity-updated': 'Thông tin hoạt động đã được cập nhật',
}

// The activity log is durable. Repair only missing deliveries, never rewrite the
// complete history when a chat is read or a realtime snapshot is refreshed.
export async function syncActivityMessages(db, activity) {
  const events = (activity.updates ?? []).filter(event => event.type === 'note' || labels[event.type])
  if (!events.length) return
  const conversations = db.collection('conversations')
  const key = `activity:${activity.id}`
  let conversation = await conversations.findOne({ key })
  if (!conversation) {
    try { await conversations.updateOne({ key }, { $setOnInsert: { id: randomUUID(), key, type: 'group', activityId: activity.id, createdAt: activity.createdAt ?? new Date() } }, { upsert: true }) }
    catch (error) { if (error.code !== 11000) throw error }
    conversation = await conversations.findOne({ key })
  }
  const persisted = await db.collection('chat_messages').find({ conversationId: conversation.id, clientMessageId: { $in: events.map(event => `activity-event:${event.id}`) } }, { projection: { senderId: 1, clientMessageId: 1 } }).toArray()
  const keys = new Set(persisted.map(row => JSON.stringify([row.senderId, row.clientMessageId])))
  let changed = false
  for (const event of events.filter(event => !keys.has(JSON.stringify([event.actorId || activity.hostId, `activity-event:${event.id}`])))) {
    const senderId = event.actorId || activity.hostId
    const filter = { conversationId: conversation.id, senderId, clientMessageId: `activity-event:${event.id}` }
    try { const result = await db.collection('chat_messages').updateOne(filter, { $setOnInsert: {
      ...filter, senderName: event.actorName || activity.hostName, text: event.text || labels[event.type],
      kind: event.type === 'note' ? 'update' : 'system', eventId: event.id, createdAt: event.createdAt,
      attachments: [], location: null, links: [],
    } }, { upsert: true }); changed ||= result.upsertedCount > 0 } catch (error) { if (error.code !== 11000) throw error }
  }
  if (changed) {
    const events = realtimeEvents(db)
    events.emit('conversation', conversation.id)
    const staff = await listAssignedStaff(db, activity)
    for (const id of new Set([activity.hostId, ...(activity.joinRequests ?? []).filter(row => row.status === 'approved').map(row => row.userId), ...staff.map(row => row.userId)])) events.emit('user', id)
  }
}

export function closedRequests(row, now = new Date()) {
  return (row.joinRequests ?? []).map(request => request.status === 'pending' ? { ...request, status: 'closed', updatedAt: now } : request)
}
