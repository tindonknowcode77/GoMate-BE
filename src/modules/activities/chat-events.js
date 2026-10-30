import { randomUUID } from 'node:crypto'

const labels = {
  'business-group-withdrawn': 'Nhóm đã được thu hồi.', 'business-group-deleted': 'Nhóm đã được xóa.',
  'schedule-confirmed': 'Đã chốt lịch hoạt động', started: 'Hoạt động đã bắt đầu', completed: 'Hoạt động đã kết thúc',
  expired: 'Hoạt động đã hết hạn', cancelled: 'Hoạt động đã bị hủy', 'plan-updated': 'Kế hoạch đã được cập nhật',
  'business-plan-updated': 'Kế hoạch đã được cập nhật', 'activity-updated': 'Thông tin hoạt động đã được cập nhật',
}

// The activity log is the durable source. Upserts repair interrupted delivery on chat reads.
export async function syncActivityMessages(db, activity) {
  const events = (activity.updates ?? []).filter(event => event.type === 'note' || labels[event.type])
  if (!events.length) return
  const conversations = db.collection('conversations')
  const key = `activity:${activity.id}`
  try { await conversations.updateOne({ key }, { $setOnInsert: { id: randomUUID(), key, type: 'group', activityId: activity.id, createdAt: activity.createdAt ?? new Date() } }, { upsert: true }) }
  catch (error) { if (error.code !== 11000) throw error }
  const conversation = await conversations.findOne({ key })
  for (const event of events) {
    const senderId = event.actorId || activity.hostId
    const filter = { conversationId: conversation.id, senderId, clientMessageId: `activity-event:${event.id}` }
    try { await db.collection('chat_messages').updateOne(filter, { $setOnInsert: {
      ...filter, senderName: event.actorName || activity.hostName, text: event.text || labels[event.type],
      kind: event.type === 'note' ? 'update' : 'system', eventId: event.id, createdAt: event.createdAt,
      attachments: [], location: null, links: [],
    } }, { upsert: true }) } catch (error) { if (error.code !== 11000) throw error }
  }
}

export function closedRequests(row, now = new Date()) {
  return (row.joinRequests ?? []).map(request => request.status === 'pending' ? { ...request, status: 'closed', updatedAt: now } : request)
}
