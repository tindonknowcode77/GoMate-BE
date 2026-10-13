import { randomUUID } from 'node:crypto'
import { publicActivity } from './validation.js'

export function createActivityRepository(db) {
  const activities = db.collection('activities')
  return {
    async create(fields, host) {
      const now = new Date()
      const row = { id: randomUUID(), ...fields, hostId: host.id, hostName: host.name,
        memberCount: 1, status: 'published', tags: fields.tags ?? [], requirements: fields.requirements ?? [], plan: fields.plan ?? [],
        version: 1, createdAt: now, updatedAt: now }
      await activities.insertOne(row)
      return row
    },
    async get(id) { return activities.findOne({ id, status: { $ne: 'deleted' } }) },
    async lifecycle(previous, hostId, fields, event) {
      return activities.findOneAndUpdate({ id: previous.id, hostId,
        status: previous.status, version: previous.version ?? { $exists: false },
      }, { $set: { ...fields, updatedAt: event.createdAt },
        $push: { updates: event }, $inc: { version: 1 } }, { returnDocument: 'after' })
    },
    async participating(userId, { page, limit, status }, requests = false) {
      const member = { userId, ...(!requests ? { status: 'approved' } : status ? { status } : {}) }
      const [result] = await activities.aggregate([
        { $match: { status: { $ne: 'deleted' }, hostId: { $ne: userId }, joinRequests: { $elemMatch: member } } },
        { $set: { ownRequest: { $arrayElemAt: [{ $filter: { input: '$joinRequests', as: 'request',
          cond: { $eq: ['$$request.userId', userId] } } }, 0] } } },
        { $unset: ['joinRequests', '_id', 'imagePublicId'] },
        { $sort: requests ? { 'ownRequest.createdAt': -1, id: 1 } : { startsAt: 1, id: 1 } },
        { $facet: { items: [{ $skip: (page - 1) * limit }, { $limit: limit }], total: [{ $count: 'count' }] } },
      ], { maxTimeMS: 5000 }).toArray()
      const total = result?.total[0]?.count ?? 0
      const items = (result?.items ?? []).map(row => requests
        ? { ...row.ownRequest, activityId: row.id, activity: publicActivity(row) }
        : publicActivity(row))
      return { items, total, page, limit, hasMore: page * limit < total }
    },
    // Keep requests and capacity in one document so approval is atomic even on standalone MongoDB.
    async submitJoinRequest(id, user) {
      const now = new Date()
      const request = { id: randomUUID(), userId: user.id, name: user.name, status: 'pending', createdAt: now, updatedAt: now }
      const row = await activities.findOneAndUpdate({ id, status: 'published', startsAt: { $gt: now }, hostId: { $ne: user.id },
        joinRequests: { $not: { $elemMatch: { userId: user.id } } },
        $expr: { $and: [{ $lt: ['$memberCount', '$maxParticipants'] }, { $lt: [{ $size: { $ifNull: ['$joinRequests', []] } }, 5000] }] },
      }, { $push: { joinRequests: request }, $set: { updatedAt: now }, $inc: { version: 1 } }, { returnDocument: 'after' })
      if (row) return request
      // Reuse the user's existing entry after cancellation/rejection; never create duplicate membership.
      const retry = await activities.findOneAndUpdate({ id, status: 'published', startsAt: { $gt: now }, hostId: { $ne: user.id },
        joinRequests: { $elemMatch: { userId: user.id, status: { $in: ['cancelled', 'rejected', 'left', 'removed'] } } },
        $expr: { $lt: ['$memberCount', '$maxParticipants'] },
      }, { $set: { 'joinRequests.$': request, updatedAt: now }, $inc: { version: 1 } }, { returnDocument: 'after' })
      return retry ? request : null
    },
    async changeJoinRequest(id, { userId, hostId, requestId, status }) {
      const now = new Date()
      const query = { id, status: 'published', startsAt: { $gt: now },
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
        'joinRequests.$.updatedAt': now, updatedAt: now },
        $inc: { memberCount: -1, version: 1 },
      }, { returnDocument: 'after' })
    },
    async owned(hostId, page, limit) {
      const query = { hostId, status: { $ne: 'deleted' } }
      const [items, total] = await Promise.all([
        activities.find(query).sort({ createdAt: -1, id: 1 }).skip((page - 1) * limit).limit(limit).toArray(),
        activities.countDocuments(query),
      ])
      return { items, total, page, limit, hasMore: page * limit < total }
    },
    async update(previous, fields) {
      return activities.findOneAndUpdate({ id: previous.id, hostId: previous.hostId,
        version: previous.version ?? { $exists: false }, status: 'published',
        memberCount: { $lte: fields.maxParticipants ?? previous.maxParticipants },
      }, { $set: { ...fields, updatedAt: new Date() }, $inc: { version: 1 } }, { returnDocument: 'after' })
    },
    async remove(previous) {
      return activities.findOneAndUpdate({ id: previous.id, hostId: previous.hostId,
        version: previous.version ?? { $exists: false }, status: { $ne: 'deleted' },
      }, { $set: { status: 'deleted', deletedAt: new Date(), updatedAt: new Date() }, $inc: { version: 1 } }, { returnDocument: 'after' })
    },
    async search(options, userId) {
      const match = { status: 'published', startsAt: { $gt: new Date() }, hostId: { $ne: userId },
        $expr: { $lt: ['$memberCount', '$maxParticipants'] } }
      if (options.q) {
        const literal = options.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        match.$or = ['title', 'description', 'location', 'tags'].map(key => ({ [key]: { $regex: literal, $options: 'i' } }))
      }
      if (options.categories.length) match.category = { $in: options.categories }
      if (options.minCost !== undefined || options.maxCost !== undefined) match.estimatedCost = {
        ...(options.minCost !== undefined ? { $gte: options.minCost } : {}),
        ...(options.maxCost !== undefined ? { $lte: options.maxCost } : {}),
      }
      const date = { date: '$startsAt', timezone: 'Asia/Bangkok' }
      const checks = [match.$expr]
      if (options.days.length) checks.push({ $in: [{ $isoDayOfWeek: date }, options.days] })
      checks.push({ $gte: [{ $hour: date }, options.fromHour] }, { $lt: [{ $hour: date }, options.toHour] })
      match.$expr = { $and: checks }
      const geo = options.lat !== undefined
      const pipeline = geo ? [{ $geoNear: { near: { type: 'Point', coordinates: [options.lng, options.lat] },
        key: 'coordinates', distanceField: 'distanceMeters', spherical: true, query: match,
        ...(options.distanceKm !== undefined ? { maxDistance: options.distanceKm * 1000 } : {}),
      } }] : [{ $match: match }]
      pipeline.push({ $sort: geo ? { distanceMeters: 1, startsAt: 1, id: 1 } : { startsAt: 1, id: 1 } },
        { $facet: {
          items: [{ $skip: (options.page - 1) * options.limit }, { $limit: options.limit },
            { $project: { _id: 0, id: 1, title: 1, hostId: 1, hostName: 1, location: 1, startsAt: 1,
              memberCount: 1, maxParticipants: 1, category: 1, tags: 1, description: 1, estimatedCost: 1,
              requirements: 1, plan: 1, imageUrl: 1, distanceKm: geo ? { $divide: ['$distanceMeters', 1000] } : { $literal: null },
            } }], total: [{ $count: 'count' }],
        } })
      const [result] = await db.collection('activities').aggregate(pipeline, { maxTimeMS: 5000 }).toArray()
      const total = result?.total[0]?.count ?? 0
      return { items: result?.items ?? [], page: options.page, limit: options.limit, total, hasMore: options.page * options.limit < total }
    },
  }
}
