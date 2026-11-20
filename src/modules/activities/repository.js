import { createBusinessAudience } from '../../common/business-audience.js'
import { syncActivityMessages, closedRequests } from './chat-events.js'
import { randomUUID } from 'node:crypto'
import { HttpError } from '../../common/http-error.js'
import { publicActivity } from './validation.js'
import { createCommunityRepository } from '../community/repository.js'
import { staffGroupScope, isAssignedStaff, isStaffAccount, listAssignedStaff } from '../../common/business-staff-access.js'
import { findConfirmedConflict, findOverlappingPending, cancelConflictingPending } from '../../common/time-conflict.js'

export function createActivityRepository(db) {
  const activities = db.collection('activities')
  const community = createCommunityRepository(db)
  const audience = createBusinessAudience(db)
  async function memberAvatars(rows) {
    if (!rows.length) return rows
    const memberships = await activities.find({ id: { $in: rows.map(row => row.id) } }, { projection: { id: 1, hostId: 1, joinRequests: 1 } }).toArray()
    const idsByActivity = new Map(memberships.map(row => [row.id, [row.hostId, ...(row.joinRequests ?? []).filter(item => item.status === 'approved').map(item => item.userId)].slice(0, 4)]))
    const ids = [...new Set([...idsByActivity.values()].flat())]
    const people = await db.collection('users').find({ id: { $in: ids } }, { projection: { id: 1, name: 1, avatar_url: 1, avatar_version: 1 } }).toArray()
    const profiles = new Map(people.map(person => [person.id, person]))
    return rows.map(row => ({ ...row, memberAvatars: (idsByActivity.get(row.id) ?? []).map(userId => { const person = profiles.get(userId); return { userId, name: person?.name || 'Thành viên', avatarUrl: person?.avatar_url || (person?.avatar_version ? `/api/profile/${userId}/avatar?v=${person.avatar_version}` : null) } }) }))
  }

  return {
    canViewBusinessGroup: audience.canView,
    isAssignedStaff: (userId, activityId) => isAssignedStaff(db, userId, activityId),
    isStaffAccount: userId => isStaffAccount(db, userId),
    listAssignedStaff: activity => listAssignedStaff(db, activity),
    async profilesByIds(userIds) {
      const ids = [...new Set(userIds.filter(Boolean))]
      if (!ids.length) return new Map()
      const people = await db.collection('users').find({ id: { $in: ids } }, { projection: { _id: 0, id: 1, name: 1, avatar_url: 1, avatar_version: 1 } }).toArray()
      return new Map(people.map(person => [person.id, {
        name: person.name,
        avatarUrl: person.avatar_url || (person.avatar_version ? `/api/profile/${person.id}/avatar?v=${person.avatar_version}` : null),
      }]))
    },
    findConfirmedConflict: (userId, targetActivity) => findConfirmedConflict(db, userId, targetActivity),
    findOverlappingPending: (userId, targetActivity) => findOverlappingPending(db, userId, targetActivity),
    cancelConflictingPending: (userId, acceptedActivity, options) => cancelConflictingPending(db, userId, acceptedActivity, options),
    async listMemories(activityId, page = 1, limit = 50) {
      const memories = db.collection('activity_memories')
      const query = { activityId, deletedAt: { $exists: false } }
      const [rows, total] = await Promise.all([
        memories.find(query, { projection: { _id: 0, imagePublicId: 0 } }).sort({ createdAt: -1, id: 1 }).skip((page - 1) * limit).limit(limit).toArray(),
        memories.countDocuments(query),
      ])
      const profiles = await this.profilesByIds(rows.map(item => item.uploaderId))
      const items = rows.map(item => {
        const user = profiles.get(item.uploaderId)
        return { ...item, uploaderName: user?.name || item.uploaderName || 'Thành viên', uploaderAvatarUrl: user?.avatarUrl ?? null }
      })
      return { items, total, page, limit, hasMore: page * limit < total }
    },
    async addMemory(activityId, user, { imageUrl, imagePublicId, caption = '' }) {
      const now = new Date()
      const row = {
        id: randomUUID(),
        activityId,
        uploaderId: user.id,
        uploaderName: user.name,
        imageUrl,
        imagePublicId: imagePublicId ?? null,
        caption,
        createdAt: now,
      }
      await db.collection('activity_memories').insertOne(row)
      const { _id, imagePublicId: _pub, ...result } = row
      return result
    },
    async deleteMemory(activityId, memoryId, actorId, isHost) {
      const query = { id: memoryId, activityId, deletedAt: { $exists: false }, ...(!isHost ? { uploaderId: actorId } : {}) }
      return db.collection('activity_memories').findOneAndUpdate(query, { $set: { deletedAt: new Date(), deletedBy: actorId } }, { returnDocument: 'after' })
    },
    async summary(activity, userId) {
      const existing = new Map((activity.attendance ?? []).map(item => [item.userId, item]))
      const approvedMembers = (activity.joinRequests ?? []).filter(item => item.status === 'approved')
      const baseMembers = [
        { userId: activity.hostId, name: activity.hostName, role: 'host' },
        ...approvedMembers.map(item => ({ userId: item.userId, name: item.name, role: 'member' })),
      ]
      const roster = baseMembers.map(item => {
        const record = existing.get(item.userId)
        return { userId: item.userId, name: item.name, role: item.role, status: record?.status ?? 'unmarked' }
      })
      const userIds = [...new Set(roster.map(item => item.userId))]
      const [people, expRatings, userSubmission, memories] = await Promise.all([
        userIds.length ? db.collection('users').find({ id: { $in: userIds } }, { projection: { _id: 0, id: 1, name: 1, avatar_url: 1, avatar_version: 1 } }).toArray() : [],
        db.collection('activity_experience_ratings').aggregate([
          { $match: { activityId: activity.id, score: { $gte: 1, $lte: 5 } } },
          { $group: { _id: null, average: { $avg: '$score' }, count: { $sum: 1 } } },
        ]).toArray(),
        db.collection('rating_submissions').findOne({ activityId: activity.id, userId }, { projection: { _id: 0, createdAt: 1 } }),
        db.collection('activity_memories').find({ activityId: activity.id, deletedAt: { $exists: false } }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(100).toArray(),
      ])
      const profileMap = new Map(people.map(person => [person.id, person]))
      const enrichedMembers = roster.map(item => {
        const person = profileMap.get(item.userId)
        return {
          ...item,
          name: person?.name || item.name,
          avatarUrl: person?.avatar_url || (person?.avatar_version ? `/api/profile/${item.userId}/avatar?v=${person.avatar_version}` : null),
        }
      })
      const presentCount = enrichedMembers.filter(m => m.status === 'present').length
      const lateCount = enrichedMembers.filter(m => m.status === 'late').length
      const absentCount = enrichedMembers.filter(m => m.status === 'absent').length
      const unmarkedCount = enrichedMembers.filter(m => m.status === 'unmarked').length
      const isHost = activity.hostId === userId
      const currentMember = enrichedMembers.find(m => m.userId === userId)
      const canRate = activity.status === 'completed' && (
        (isHost && activity.organizerType === 'business') ||
        ['present', 'late'].includes(currentMember?.status)
      )
      return {
        activityId: activity.id,
        title: activity.title,
        category: activity.category,
        organizerType: activity.organizerType || 'personal',
        status: activity.status,
        startsAt: activity.startsAt,
        endsAt: activity.endsAt ?? null,
        completedAt: activity.completedAt ?? activity.autoCompletedAt ?? null,
        location: activity.location,
        imageUrl: activity.imageUrl ?? null,
        hostId: activity.hostId,
        hostName: activity.hostName,
        attendance: {
          total: enrichedMembers.length,
          attendedCount: presentCount + lateCount,
          presentCount,
          lateCount,
          absentCount,
          unmarkedCount,
          members: enrichedMembers,
        },
        rating: {
          average: expRatings[0]?.average ?? null,
          count: expRatings[0]?.count ?? 0,
          hasRated: Boolean(userSubmission),
          canRate: Boolean(canRate),
          isHost,
        },
        memories,
        coverImages: activity.imageUrls ?? (activity.imageUrl ? [activity.imageUrl] : []),
      }
    },
    async create(fields, host) {
      const now = new Date()
      const normTitle = String(fields.title || '').trim().toLowerCase()
      const duplicate = await activities.findOne({
        hostId: host.id,
        status: 'published',
        startsAt: fields.startsAt,
        createdAt: { $gte: new Date(now.getTime() - 5 * 60 * 1000) },
      })
      if (duplicate && String(duplicate.title || '').trim().toLowerCase() === normTitle) {
        throw new HttpError(409, 'Hoạt động giống hệt vừa được tạo. Vui lòng không bấm gửi nhiều lần.')
      }
      const { initialMembers = [], initialFriendIds: _initialFriendIds, ...stored } = fields
      const invitations = initialMembers.map(user => ({ id: randomUUID(), userId: user.id, name: user.name, status: 'pending', useReservedSeats: false, createdAt: now, updatedAt: now }))
      const row = { id: randomUUID(), organizerType: 'personal', ...stored, invitations, hostId: host.id, hostName: host.name,
        memberCount: 1 + (fields.reservedSeats ?? 0), status: 'published', tags: fields.tags ?? [], requirements: fields.requirements ?? [], plan: fields.plan ?? [],
        version: 1, createdAt: now, updatedAt: now }
      await activities.insertOne(row)
      return row
    },
    async get(id) { return activities.findOne({ id, status: { $ne: 'deleted' } }, { projection: { planFileData: 0 } }) },
    async getWithPlanFile(id) { return activities.findOne({ id, status: { $ne: 'deleted' } }) },
    async lifecycle(previous, hostId, fields, event) {
      if (fields.status && fields.status !== 'published') fields = { ...fields, joinRequests: closedRequests(previous, event.createdAt) }
      const row = await activities.findOneAndUpdate({ id: previous.id, hostId,
        status: previous.status, version: previous.version ?? { $exists: false },
      }, { $set: { ...fields, updatedAt: event.createdAt },
        $push: { updates: event }, $inc: { version: 1 } }, { returnDocument: 'after' })
      if (row) await syncActivityMessages(db, row)
      return row
    },
    async counts(userId) {
      const upcoming = { status: 'published', startsAt: { $gt: new Date() } }
      const pending = await activities.countDocuments({ ...upcoming, joinRequests: { $elemMatch: { userId, status: 'pending' } } })
      const owned = await activities.find({ ...upcoming, $or: [{ hostId: userId }, await staffGroupScope(db, userId)] }, { projection: { joinRequests: 1 } }).toArray()
      return { pending, hostRequests: owned.reduce((total, row) => total + (row.joinRequests ?? []).filter(item => item.status === 'pending').length, 0) }
    },
    async participating(userId, { page, limit, status }, requests = false) {
      const member = { userId, ...(!requests ? { status: 'approved' } : status ? { status } : {}) }
      const managed = requests ? [] : await activities.find(await staffGroupScope(db, userId), { projection: { id: 1 } }).toArray()
      const managedIds = managed.map(row => row.id)
      const [result] = await activities.aggregate([
        { $match: { $and: [await audience.scope(userId, true)], ...(requests && status === 'pending' ? { status: 'published', startsAt: { $gt: new Date() } } : { status: { $nin: ['deleted', 'pending-review'] } }), hostId: { $ne: userId }, $or: [{ joinRequests: { $elemMatch: member } }, { id: { $in: managedIds } }] } },
        { $set: { ownRequest: { $arrayElemAt: [{ $filter: { input: '$joinRequests', as: 'request',
          cond: { $eq: ['$$request.userId', userId] } } }, 0] } } },
        { $unset: ['joinRequests', '_id', 'imagePublicId', 'planFileData'] },
        { $sort: requests ? { 'ownRequest.createdAt': -1, id: 1 } : { startsAt: 1, id: 1 } },
        { $facet: { items: [{ $skip: (page - 1) * limit }, { $limit: limit }], total: [{ $count: 'count' }] } },
      ], { maxTimeMS: 5000 }).toArray()
      const total = result?.total[0]?.count ?? 0
      const items = (result?.items ?? []).map(row => requests
        ? { ...row.ownRequest, activityId: row.id, activity: publicActivity(row) }
        : { ...publicActivity(row), isBusinessManager: managedIds.includes(row.id) })
      return { items: requests ? items : await memberAvatars(items), total, page, limit, hasMore: page * limit < total }
    },
    // Keep requests and capacity in one document so approval is atomic even on standalone MongoDB.
    async submitJoinRequest(id, user, version) {
      const target = await activities.findOne({ id }, { projection: { planFileData: 0 } }); if (target && !await audience.canView(target, user.id)) return null
      const now = new Date()
      const autoApprove = target?.organizerType === 'business' && target.autoApproveMembers === true
      const policy = target?.autoApproveMembers === true ? true : { $ne: true }
      const request = { id: randomUUID(), userId: user.id, name: user.name, status: autoApprove ? 'approved' : 'pending', createdAt: now, updatedAt: now }
      const row = await activities.findOneAndUpdate({ id, status: 'published', startsAt: { $gt: now }, hostId: { $ne: user.id },
        autoApproveMembers: policy,
        ...(version !== undefined ? { version } : {}),
        $or: [{ registrationDeadline: null }, { registrationDeadline: { $gt: now } }],
        joinRequests: { $not: { $elemMatch: { userId: user.id } } },
        $expr: { $and: [{ $lt: ['$memberCount', '$maxParticipants'] }, { $lt: [{ $size: { $ifNull: ['$joinRequests', []] } }, 5000] }] },
      }, { $push: { joinRequests: request }, $set: { updatedAt: now, ...(autoApprove ? { scheduleConfirmedAt: null, scheduleConfirmedBy: null } : {}) }, $inc: { version: 1, ...(autoApprove ? { memberCount: 1 } : {}) } }, { returnDocument: 'after' })
      if (row) return request
      // Reuse the user's existing entry after cancellation/rejection; never create duplicate membership.
      const retry = await activities.findOneAndUpdate({ id, status: 'published', startsAt: { $gt: now }, hostId: { $ne: user.id },
        autoApproveMembers: policy,
        ...(version !== undefined ? { version } : {}),
        $or: [{ registrationDeadline: null }, { registrationDeadline: { $gt: now } }],
        joinRequests: { $elemMatch: { userId: user.id, status: { $in: ['cancelled', 'cancelled_conflict', 'rejected', 'left', 'removed'] } } },
        $expr: { $lt: ['$memberCount', '$maxParticipants'] },
      }, { $set: { 'joinRequests.$': request, updatedAt: now, ...(autoApprove ? { scheduleConfirmedAt: null, scheduleConfirmedBy: null } : {}) }, $inc: { version: 1, ...(autoApprove ? { memberCount: 1 } : {}) } }, { returnDocument: 'after' })
      return retry ? request : null
    },
    async changeJoinRequest(id, { userId, hostId, requestId, status, version }) {
      const now = new Date()
      const query = { id, ...(status === 'cancelled' ? { status: { $ne: 'deleted' } } : { status: 'published', startsAt: { $gt: now } }), ...(version !== undefined ? { version } : {}),
        ...(hostId ? { hostId } : {}),
        joinRequests: { $elemMatch: { ...(userId ? { userId } : { id: requestId }), status: 'pending' } },
        ...(status === 'approved' ? { $expr: { $lt: ['$memberCount', '$maxParticipants'] } } : {}),
      }
      const row = await activities.findOneAndUpdate(query, {
        $set: { 'joinRequests.$.status': status, 'joinRequests.$.updatedAt': now, updatedAt: now },
        $inc: { version: 1, ...(status === 'approved' ? { memberCount: 1 } : {}) },
      }, { returnDocument: 'after' })
      return row?.joinRequests.find(item => userId ? item.userId === userId : item.id === requestId) ?? null
    },
    async removeMember(id, userId, actorId, hostAction) {
      const now = new Date()
      if (!hostAction && actorId !== userId) return null
      return activities.findOneAndUpdate({ id, status: 'published', startsAt: { $gt: now },
        hostId: { $ne: userId },
        memberCount: { $gte: 1 },
        joinRequests: { $elemMatch: { userId, status: 'approved' } },
      }, { $set: { 'joinRequests.$.status': hostAction ? 'removed' : 'left',
        'joinRequests.$.updatedAt': now, updatedAt: now, scheduleConfirmedAt: null, scheduleConfirmedBy: null },
        $pull: { businessReceipts: { userId }, leaveRequests: { userId, status: 'pending' } },
        $inc: { memberCount: -1, version: 1 },
      }, { returnDocument: 'after' })
    },
    async submitLeaveRequest(id, user, reason) {
      const now = new Date()
      const request = { id: randomUUID(), userId: user.id, name: user.name, reason, status: 'pending', createdAt: now, updatedAt: now }
      const row = await activities.findOneAndUpdate(
        {
          id,
          status: 'published',
          startsAt: { $gt: now },
          joinRequests: { $elemMatch: { userId: user.id, status: 'approved' } },
          leaveRequests: { $not: { $elemMatch: { userId: user.id, status: 'pending' } } },
        },
        { $push: { leaveRequests: request }, $set: { updatedAt: now }, $inc: { version: 1 } },
        { returnDocument: 'after' }
      )
      return row ? request : null
    },
    async owned(hostId, page, limit) {
      const query = { hostId, status: { $ne: 'deleted' } }
      const [items, total] = await Promise.all([
        activities.find(query, { projection: { planFileData: 0 } }).sort({ createdAt: -1, id: 1 }).skip((page - 1) * limit).limit(limit).toArray(),
        activities.countDocuments(query),
      ])
      return { items: await memberAvatars(items), total, page, limit, hasMore: page * limit < total }
    },
    async invitations(userId, page, limit) {
      const query = { status: 'published', startsAt: { $gt: new Date() }, invitations: { $elemMatch: { userId, status: 'pending' } } }
      const [rows, total] = await Promise.all([activities.find(query, { projection: { planFileData: 0 } }).sort({ createdAt: -1, id: 1 }).skip((page - 1) * limit).limit(limit).toArray(), activities.countDocuments(query)])
      return { items: rows.map(row => ({ ...row.invitations.find(item => item.userId === userId && item.status === 'pending'), activityId: row.id, activity: publicActivity(row) })), total, page, limit, hasMore: page * limit < total }
    },
    async addFriends(previous, people, useReservedSeats) {
      const existing = previous.invitations ?? [], members = previous.joinRequests ?? []
      const fresh = people.filter(person => !members.some(item => item.userId === person.id && ['approved', 'pending'].includes(item.status)) && !existing.some(item => item.userId === person.id && ['pending', 'accepted'].includes(item.status)))
      if (!fresh.length) return previous
      const now = new Date(), invitations = fresh.map(user => ({ id: randomUUID(), userId: user.id, name: user.name, status: 'pending', useReservedSeats, createdAt: now, updatedAt: now }))
      if (existing.length + invitations.length > 5000) return null
      return activities.findOneAndUpdate({ id: previous.id, hostId: previous.hostId, status: 'published', startsAt: { $gt: now }, version: previous.version ?? { $exists: false } },
        { $set: { invitations: [...existing.filter(item => !fresh.some(person => person.id === item.userId)), ...invitations], updatedAt: now }, $inc: { version: 1 } }, { returnDocument: 'after' })
    },
    async decideInvitation(previous, invitation, status) {
      const now = new Date(), accepting = status === 'accepted'
      const consumed = accepting && invitation.useReservedSeats ? Math.min(previous.reservedSeats ?? 0, 1) : 0
      if (accepting && (previous.joinRequests ?? []).some(item => item.userId === invitation.userId && ['approved', 'pending'].includes(item.status))) return null
      const request = { id: randomUUID(), userId: invitation.userId, name: invitation.name, status: 'approved', source: 'host-invited', createdAt: now, updatedAt: now }
      return activities.findOneAndUpdate({ id: previous.id, status: 'published', startsAt: { $gt: now }, version: previous.version,
        invitations: { $elemMatch: { id: invitation.id, userId: invitation.userId, status: 'pending' } },
        ...(accepting ? { $or: [{ registrationDeadline: null }, { registrationDeadline: { $gt: now } }], $expr: { $lte: [{ $add: ['$memberCount', 1 - consumed] }, '$maxParticipants'] } } : {}),
      }, { $set: { invitations: previous.invitations.map(item => item.id === invitation.id ? { ...item, status, updatedAt: now } : item), updatedAt: now,
          ...(accepting ? { joinRequests: [...(previous.joinRequests ?? []).filter(item => item.userId !== invitation.userId), request], companions: (previous.companions ?? []).slice(consumed), scheduleConfirmedAt: null, scheduleConfirmedBy: null } : {}),
        }, $inc: { version: 1, ...(accepting ? { memberCount: 1 - consumed, reservedSeats: -consumed } : {}) } }, { returnDocument: 'after' })
    },
    async savePlan(previous, fields) {
      return activities.findOneAndUpdate({ id: previous.id, hostId: previous.hostId, status: { $in: ['published', 'in-progress'] }, version: previous.version ?? { $exists: false } }, { $set: { ...fields, updatedAt: new Date() }, $inc: { version: 1 } }, { returnDocument: 'after' })
    },
    async update(previous, fields) {
      return activities.findOneAndUpdate({ id: previous.id, hostId: previous.hostId,
        version: previous.version ?? { $exists: false }, status: 'published',
        $expr: { $lte: [{ $add: ['$memberCount', (fields.reservedSeats ?? previous.reservedSeats ?? 0) - (previous.reservedSeats ?? 0)] }, fields.maxParticipants ?? previous.maxParticipants] },
      }, { $set: { ...fields, updatedAt: new Date() }, $inc: { version: 1, memberCount: (fields.reservedSeats ?? previous.reservedSeats ?? 0) - (previous.reservedSeats ?? 0) } }, { returnDocument: 'after' })
    },
    async remove(previous) {
      return activities.findOneAndUpdate({ id: previous.id, hostId: previous.hostId,
        version: previous.version ?? { $exists: false }, status: { $ne: 'deleted' },
      }, { $set: { status: 'deleted', deletedAt: new Date(), updatedAt: new Date() }, $unset: { planFileData: '' }, $inc: { version: 1 } }, { returnDocument: 'after' })
    },
    async favorites(ids, page, limit, userId) {
      const query = { id: { $in: ids }, status: { $ne: 'deleted' }, ...(userId ? { $and: [await audience.scope(userId)] } : {}) }
      const [rows, total] = await Promise.all([activities.find(query, { projection: { planFileData: 0 } }).sort({ startsAt: 1, id: 1 }).skip((page - 1) * limit).limit(limit).toArray(), activities.countDocuments(query)])
      return { items: rows.map(publicActivity), total, page, limit, hasMore: page * limit < total }
    },
    async search(options, userId, profile = {}) {
      if (await isStaffAccount(db, userId)) return { items: [], page: options.page, limit: options.limit, total: 0, hasMore: false }
      const excluded = await community.blockedIds(userId)
      const match = { status: 'published', startsAt: { $gt: new Date() }, hostId: { $nin: [userId, ...excluded] },
        $expr: { $lt: ['$memberCount', '$maxParticipants'] },
        $or: [{ registrationDeadline: null }, { registrationDeadline: { $gt: new Date() } }] }
      if (options.organizerType) match.organizerType = options.organizerType === 'personal' ? { $ne: 'business' } : 'business'
      if (options.q) {
        const literal = options.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        match.$and = [{ $or: ['title', 'description', 'location', 'tags'].map(key => ({ [key]: { $regex: literal, $options: 'i' } })) }]
      }
      if (options.categories.length) match.category = { $in: options.categories }
      if (options.minCost !== undefined || options.maxCost !== undefined) match.estimatedCost = {
        ...(options.minCost !== undefined ? { $gte: options.minCost } : {}),
        ...(options.maxCost !== undefined ? { $lte: options.maxCost } : {}),
      }
      const date = { date: '$startsAt', timezone: 'Asia/Bangkok' }
      const checks = [match.$expr]
      if (options.dateFrom || options.dateTo) {
        const day = { $dateToString: { ...date, format: '%Y-%m-%d' } }
        if (options.dateFrom) checks.push({ $gte: [day, options.dateFrom] })
        if (options.dateTo) checks.push({ $lte: [day, options.dateTo] })
      }
      const minutes = { $add: [{ $multiply: [{ $hour: date }, 60] }, { $minute: date }] }
      if (options.fromTime !== undefined) checks.push({ $gte: [minutes, options.fromTime] })
      if (options.toTime !== undefined) checks.push({ $lte: [minutes, options.toTime] })
      if (options.minParticipants !== undefined) checks.push({ $gte: [{ $ifNull: ['$minParticipants', 2] }, options.minParticipants] })
      if (options.maxParticipants !== undefined) checks.push({ $lte: ['$maxParticipants', options.maxParticipants] })
      for (const [key, field] of [['gender', 'genders'], ['language', 'languages'], ['religion', 'religions']]) if (options[key]) {
        const list = { $ifNull: [`$participantPreferences.${field}`, []] }
        checks.push({ $or: [{ $eq: [{ $size: list }, 0] }, { $in: [options[key], list] }] })
      }
      if (options.minAge) checks.push({ $or: [{ $eq: [{ $ifNull: ['$participantPreferences.maxAge', 0] }, 0] }, { $gte: ['$participantPreferences.maxAge', options.minAge] }] })
      if (options.maxAge) checks.push({ $lte: [{ $ifNull: ['$participantPreferences.minAge', 0] }, options.maxAge] })
      if (options.alcohol) checks.push({ $in: [{ $ifNull: ['$participantPreferences.alcohol', 'any'] }, ['any', options.alcohol]] })
      if (options.dressCode) checks.push({ [options.dressCode === 'yes' ? '$ne' : '$eq']: [{ $ifNull: ['$participantPreferences.dressCode', ''] }, ''] })
      if (options.days.length) checks.push({ $in: [{ $isoDayOfWeek: date }, options.days] })
      checks.push({ $gte: [{ $hour: date }, options.fromHour] }, { $lt: [{ $hour: date }, options.toHour] })
      match.$expr = { $and: checks }
      match.$and = [...(match.$and || []), await audience.scope(userId)]
      const geo = options.lat !== undefined
      const pipeline = geo ? [{ $geoNear: { near: { type: 'Point', coordinates: [options.lng, options.lat] },
        key: 'coordinates', distanceField: 'distanceMeters', spherical: true, query: match,
        ...(options.distanceKm !== undefined ? { maxDistance: options.distanceKm * 1000 } : {}),
      } }] : [{ $match: match }]
      pipeline.push({ $unset: 'planFileData' })
      if (options.sort === 'recommended') {
        const interests = (profile?.interests ?? []).slice(0, 12)
        const signals = profile?.match_signals ?? {}
        pipeline.push({ $set: { matchScore: { $add: [
          { $multiply: [4, { $size: { $setIntersection: [{ $ifNull: ['$tags', []] }, { $literal: interests }] } }] },
          { $cond: [{ $in: ['$category', { $literal: interests }] }, 5, 0] },
          ...interests.map(interest => ({ $cond: [{ $regexMatch: {
            input: { $concat: ['$title', ' ', '$description'] },
            regex: interest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i',
          } }, 2, 0] })),
          { $switch: { branches: [['__none__', 0], ...Object.entries(signals)].filter(([key]) => typeof key === 'string').map(([key, value]) => ({ case: { $eq: ['$category', key] }, then: Math.max(-10, Math.min(10, Number(value) || 0)) })), default: 0 } },
        ] } } })
      }
      const sort = { ...(options.sort === 'recommended' ? { matchScore: -1 } : {}),
        ...(geo && options.sort !== 'soonest' ? { distanceMeters: 1 } : {}), startsAt: 1, id: 1 }
      pipeline.push({ $sort: sort },
        { $facet: {
          items: [{ $skip: (options.page - 1) * options.limit }, { $limit: options.limit },
            { $project: { _id: 0, id: 1, title: 1, hostId: 1, hostName: 1, location: 1, organizerType: { $ifNull: ['$organizerType', 'personal'] }, coordinates: 1, startsAt: 1,
              requestStatus: { $let: { vars: { own: { $arrayElemAt: [{ $filter: { input: { $ifNull: ['$joinRequests', []] }, as: 'request', cond: { $eq: ['$$request.userId', userId] } } }, 0] } }, in: '$$own.status' } },
              address: 1, province: 1, district: 1, ward: 1, costNote: 1, reservedSeats: 1, itinerary: 1, planLink: 1, planFile: 1, memberCount: 1, minParticipants: 1, maxParticipants: 1, participantPreferences: 1, endsAt: 1, registrationDeadline: 1, meetingPoint: 1, financialConfig: 1, category: 1, tags: 1, description: 1, estimatedCost: 1,
              requirements: 1, plan: 1, imageUrl: 1, imageUrls: 1, business: 1, distanceKm: geo ? { $divide: ['$distanceMeters', 1000] } : { $literal: null },
            } }], total: [{ $count: 'count' }],
        } })
      const [result] = await db.collection('activities').aggregate(pipeline, { maxTimeMS: 5000 }).toArray()
      const total = result?.total[0]?.count ?? 0
      const reputations = await community.reputations((result?.items ?? []).map(row => row.hostId))
      const hostProfiles = await db.collection('users').find({ id: { $in: [...new Set((result?.items ?? []).map(row => row.hostId))] } }, { projection: { id: 1, avatar_url: 1, avatar_version: 1 } }).toArray()
      const avatars = new Map(hostProfiles.map(user => [user.id, user.avatar_url ?? (user.avatar_version ? `/api/profile/${user.id}/avatar?v=${user.avatar_version}` : null)]))
      const items = (result?.items ?? []).map(row => ({ ...row, hostAvatarUrl: avatars.get(row.hostId) ?? null, hostRating: reputations.get(row.hostId)?.average, hostRatingCount: reputations.get(row.hostId)?.count, hostCompletedActivities: reputations.get(row.hostId)?.completedActivities }))
      return { items, page: options.page, limit: options.limit, total, hasMore: options.page * options.limit < total }
    },
  }
}
