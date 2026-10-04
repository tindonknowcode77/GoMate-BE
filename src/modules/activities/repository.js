export function createActivityRepository(db) {
  return {
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
