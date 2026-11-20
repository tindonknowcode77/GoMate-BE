const DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000

export function activityTimeRange(activity) {
  const start = new Date(activity.startsAt).getTime()
  const rawEnd = activity.endsAt ? new Date(activity.endsAt).getTime() : NaN
  const end = Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : start + DEFAULT_DURATION_MS
  return { start, end }
}

export function rangesOverlap(a, b) {
  return a.start < b.end && b.start < a.end
}

export async function findConfirmedConflict(db, userId, targetActivity) {
  if (!userId || !targetActivity?.startsAt) return null
  const targetRange = activityTimeRange(targetActivity)
  const candidates = await db.collection('activities').find(
    {
      id: { $ne: targetActivity.id },
      status: { $in: ['published', 'in-progress'] },
      startsAt: { $lt: new Date(targetRange.end) },
      $or: [
        { hostId: userId },
        { joinRequests: { $elemMatch: { userId, status: 'approved' } } },
      ],
    },
    { projection: { _id: 0, id: 1, title: 1, startsAt: 1, endsAt: 1, status: 1 } }
  ).toArray()
  return candidates.find(candidate => rangesOverlap(targetRange, activityTimeRange(candidate))) || null
}

export async function findOverlappingPending(db, userId, targetActivity) {
  if (!userId || !targetActivity?.startsAt) return []
  const targetRange = activityTimeRange(targetActivity)
  const candidates = await db.collection('activities').find(
    {
      id: { $ne: targetActivity.id },
      status: 'published',
      startsAt: { $lt: new Date(targetRange.end) },
      $or: [
        { joinRequests: { $elemMatch: { userId, status: 'pending' } } },
        { invitations: { $elemMatch: { userId, status: 'pending' } } },
      ],
    },
    { projection: { _id: 0, id: 1, title: 1, startsAt: 1, endsAt: 1, joinRequests: 1, invitations: 1 } }
  ).toArray()
  return candidates.filter(candidate => rangesOverlap(targetRange, activityTimeRange(candidate)))
}

export async function cancelConflictingPending(db, userId, acceptedActivity, { community, actorId } = {}) {
  const overlapping = await findOverlappingPending(db, userId, acceptedActivity)
  if (!overlapping.length) return []
  const activities = db.collection('activities')
  const now = new Date()
  const cancelled = []
  for (const other of overlapping) {
    const hasPendingRequest = (other.joinRequests ?? []).some(item => item.userId === userId && item.status === 'pending')
    const hasPendingInvite = (other.invitations ?? []).some(item => item.userId === userId && item.status === 'pending')
    if (!hasPendingRequest && !hasPendingInvite) continue
    const setFields = { updatedAt: now }
    const arrayFilters = []
    if (hasPendingRequest) {
      setFields['joinRequests.$[req].status'] = 'cancelled_conflict'
      setFields['joinRequests.$[req].conflictActivityId'] = acceptedActivity.id
      setFields['joinRequests.$[req].conflictActivityTitle'] = acceptedActivity.title
      setFields['joinRequests.$[req].updatedAt'] = now
      arrayFilters.push({ 'req.userId': userId, 'req.status': 'pending' })
    }
    if (hasPendingInvite) {
      setFields['invitations.$[inv].status'] = 'cancelled_conflict'
      setFields['invitations.$[inv].conflictActivityId'] = acceptedActivity.id
      setFields['invitations.$[inv].conflictActivityTitle'] = acceptedActivity.title
      setFields['invitations.$[inv].updatedAt'] = now
      arrayFilters.push({ 'inv.userId': userId, 'inv.status': 'pending' })
    }
    const result = await activities.updateOne(
      { id: other.id, status: 'published' },
      { $set: setFields, $inc: { version: 1 } },
      { arrayFilters }
    )
    if (result.modifiedCount > 0) {
      cancelled.push({
        activityId: other.id,
        title: other.title,
        startsAt: other.startsAt,
        endsAt: other.endsAt,
        kind: hasPendingRequest && hasPendingInvite ? 'both' : hasPendingRequest ? 'join-request' : 'invitation',
      })
    }
  }
  if (cancelled.length && community) {
    const names = cancelled.slice(0, 3).map(item => item.title).join(', ')
    const suffix = cancelled.length > 3 ? ` và ${cancelled.length - 3} hoạt động khác` : ''
    await community.notify(userId, {
      key: `schedule-conflict-cancelled:${acceptedActivity.id}:${userId}:${cancelled.map(item => item.activityId).sort().join(',')}`,
      type: 'activity',
      title: 'Yêu cầu trùng khung giờ đã bị vô hiệu hóa',
      text: `Bạn đã được chấp nhận vào "${acceptedActivity.title}". Do đã có hoạt động trong khung giờ này, ${cancelled.length} yêu cầu khác (${names}${suffix}) đã tự động bị vô hiệu hóa.`,
      activityId: acceptedActivity.id,
      actorId: actorId || acceptedActivity.hostId,
    })
  }
  return cancelled
}
