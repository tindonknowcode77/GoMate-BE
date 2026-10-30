import { syncActivityMessages, closedRequests } from './chat-events.js'
import { randomUUID } from 'node:crypto'
import { publicActivity } from './validation.js'
import { createCommunityRepository } from '../community/repository.js'
import { staffGroupScope, isAssignedStaff } from '../../common/business-staff-access.js'

export function createActivityRepository(db) {
  const activities = db.collection('activities')
  const community = createCommunityRepository(db)
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
    isAssignedStaff: (userId, activityId) => isAssignedStaff(db, userId, activityId),
    async create(fields, host) {
      const now = new Date()
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
      const owned = await activities.find({ ...upcoming, hostId: userId }, { projection: { joinRequests: 1 } }).toArray()
      return { pending, hostRequests: owned.reduce((total, row) => total + (row.joinRequests ?? []).filter(item => item.status === 'pending').length, 0) }
    },
    async participating(userId, { page, limit, status }, requests = false) {
      const member = { userId, ...(!requests ? { status: 'approved' } : status ? { status } : {}) }
      const managed = requests ? [] : await activities.find(await staffGroupScope(db, userId), { projection: { id: 1 } }).toArray()
      const managedIds = managed.map(row => row.id)
      const [result] = await activities.aggregate([
        { $match: { ...(requests && status === 'pending' ? { status: 'published', startsAt: { $gt: new Date() } } : { status: { $nin: ['deleted', 'pending-review'] } }), hostId: { $ne: userId }, $or: [{ joinRequests: { $elemMatch: member } }, { id: { $in: managedIds } }] } },
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
      const now = new Date()
      const request = { id: randomUUID(), userId: user.id, name: user.name, status: 'pending', createdAt: now, updatedAt: now }
      const row = await activities.findOneAndUpdate({ id, status: 'published', startsAt: { $gt: now }, hostId: { $ne: user.id },
        ...(version !== undefined ? { version } : {}),
        $or: [{ registrationDeadline: null }, { registrationDeadline: { $gt: now } }],
        joinRequests: { $not: { $elemMatch: { userId: user.id } } },
        $expr: { $and: [{ $lt: ['$memberCount', '$maxParticipants'] }, { $lt: [{ $size: { $ifNull: ['$joinRequests', []] } }, 5000] }] },
      }, { $push: { joinRequests: request }, $set: { updatedAt: now }, $inc: { version: 1 } }, { returnDocument: 'after' })
      if (row) return request
      // Reuse the user's existing entry after cancellation/rejection; never create duplicate membership.
      const retry = await activities.findOneAndUpdate({ id, status: 'published', startsAt: { $gt: now }, hostId: { $ne: user.id },
        ...(version !== undefined ? { version } : {}),
        $or: [{ registrationDeadline: null }, { registrationDeadline: { $gt: now } }],
        joinRequests: { $elemMatch: { userId: user.id, status: { $in: ['cancelled', 'rejected', 'left', 'removed'] } } },
        $expr: { $lt: ['$memberCount', '$maxParticipants'] },
      }, { $set: { 'joinRequests.$': request, updatedAt: now }, $inc: { version: 1 } }, { returnDocument: 'after' })
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
        hostId: hostAction ? { $eq: actorId, $ne: userId } : { $ne: userId },
        memberCount: { $gt: 1 },
        joinRequests: { $elemMatch: { userId, status: 'approved' } },
      }, { $set: { 'joinRequests.$.status': hostAction ? 'removed' : 'left',
        'joinRequests.$.updatedAt': now, updatedAt: now, scheduleConfirmedAt: null, scheduleConfirmedBy: null },
        $inc: { memberCount: -1, version: 1 },
      }, { returnDocument: 'after' })
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
      const [rows, total] = await Promise.all([activities.find(query).sort({ createdAt: -1, id: 1 }).skip((page - 1) * limit).limit(limit).toArray(), activities.countDocuments(query)])
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
    async favorites(ids, page, limit) {
      const query = { id: { $in: ids }, status: { $ne: 'deleted' } }
      const [rows, total] = await Promise.all([activities.find(query, { projection: { planFileData: 0 } }).sort({ startsAt: 1, id: 1 }).skip((page - 1) * limit).limit(limit).toArray(), activities.countDocuments(query)])
      return { items: rows.map(publicActivity), total, page, limit, hasMore: page * limit < total }
    },
    async search(options, userId, profile = {}) {
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
              address: 1, province: 1, district: 1, ward: 1, costNote: 1, reservedSeats: 1, itinerary: 1, planLink: 1, planFile: 1, memberCount: 1, minParticipants: 1, maxParticipants: 1, participantPreferences: 1, endsAt: 1, registrationDeadline: 1, meetingPoint: 1, financialConfig: 1, category: 1, tags: 1, description: 1, estimatedCost: 1,
              requirements: 1, plan: 1, imageUrl: 1, imageUrls: 1, business: 1, distanceKm: geo ? { $divide: ['$distanceMeters', 1000] } : { $literal: null },
            } }], total: [{ $count: 'count' }],
        } })
      const [result] = await db.collection('activities').aggregate(pipeline, { maxTimeMS: 5000 }).toArray()
      const total = result?.total[0]?.count ?? 0
      const reputations = new Map(await Promise.all([...new Set((result?.items ?? []).map(row => row.hostId))].map(async id => [id, await community.reputation(id)])))
      const hostProfiles = await db.collection('users').find({ id: { $in: [...new Set((result?.items ?? []).map(row => row.hostId))] } }, { projection: { id: 1, avatar_url: 1, avatar_version: 1 } }).toArray()
      const avatars = new Map(hostProfiles.map(user => [user.id, user.avatar_url ?? (user.avatar_version ? `/api/profile/${user.id}/avatar?v=${user.avatar_version}` : null)]))
      const items = (result?.items ?? []).map(row => ({ ...row, hostAvatarUrl: avatars.get(row.hostId) ?? null, hostRating: reputations.get(row.hostId)?.average, hostRatingCount: reputations.get(row.hostId)?.count, hostCompletedActivities: reputations.get(row.hostId)?.completedActivities }))
      return { items, page: options.page, limit: options.limit, total, hasMore: options.page * options.limit < total }
    },
  }
}
