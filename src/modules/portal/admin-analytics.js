import { HttpError } from '../../common/http-error.js'
import { fields } from './validation.js'
import { adminId } from './admin-validation.js'

const zone = 'Asia/Ho_Chi_Minh'
const day = 86400000
const offset = 7 * 3600000
const alive = { deletedAt: { $exists: false } }
const visible = { ...alive, status: { $ne: 'deleted' } }
const created = { $ifNull: ['$createdAt', '$created_at'] }
const aggregate = (db, name, pipeline) => db.collection(name).aggregate(pipeline, { maxTimeMS: 10000 }).toArray()
const percentage = (current, previous) => previous ? (current - previous) / previous * 100 : current ? null : 0
const localDate = value => new Date(+value + offset).toISOString().slice(0, 10)
const startOfMonth = (year, month) => new Date(Date.UTC(year, month - 1, 1) - offset)

export function analyticsQuery(kind, query) {
  fields(query, kind === 'dashboard' ? ['period'] : kind === 'revenue' ? ['type', 'year', 'month', 'businessId'] : [])
  if (kind === 'dashboard') {
    const period = query.period ?? 'week'
    if (!['week', 'month'].includes(period)) throw new HttpError(400, 'Invalid dashboard period')
    return { period }
  }
  if (kind !== 'revenue') return {}
  const type = query.type ?? 'monthly', year = query.year ?? String(new Date().getUTCFullYear())
  if (!['monthly', 'yearly'].includes(type) || typeof year !== 'string' || !/^\d{4}$/.test(year) || +year < 2000 || +year > 2100) throw new HttpError(400, 'Invalid revenue period')
  const month = query.month ?? String(new Date(Date.now() + offset).getUTCMonth() + 1)
  if (type === 'yearly' && query.month !== undefined || typeof month !== 'string' || !/^(?:[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, 'Invalid revenue month')
  return { type, year: +year, ...(type === 'monthly' ? { month: +month } : {}), ...(query.businessId !== undefined ? { businessId: adminId(query.businessId) } : {}) }
}

export function createAdminAnalytics(db) {
  const count = (name, filter) => db.collection(name).countDocuments(filter)
  return {
    async dashboard({ period }, now = new Date()) {
      const upcomingFilter = { ...alive, status: 'published', startsAt: { $gt: now, $lte: new Date(+now + 7 * day) } }
      const today = new Date(Date.parse(localDate(now)) - offset)
      const days = period === 'week' ? 7 : 30, trendStart = new Date(+today - days * day)
      const local = new Date(+today + offset)
      const currentEnd = period === 'month' ? startOfMonth(local.getUTCFullYear(), local.getUTCMonth() + 1) : new Date(+today - ((local.getUTCDay() + 6) % 7) * day)
      const currentStart = period === 'month' ? startOfMonth(local.getUTCFullYear(), local.getUTCMonth()) : new Date(+currentEnd - 7 * day)
      const previousStart = period === 'month' ? startOfMonth(local.getUTCFullYear(), local.getUTCMonth() - 1) : new Date(+currentStart - 7 * day)
      const summary = name => aggregate(db, name, [{ $match: name === 'users' ? alive : visible }, { $set: { date: created } }, { $facet: {
        trend: [{ $match: { date: { $gte: trendStart, $lt: today } } }, { $group: { _id: { $dateToString: { date: '$date', format: '%Y-%m-%d', timezone: zone } }, count: { $sum: 1 } } }],
        growth: [{ $match: { date: { $gte: previousStart, $lt: currentEnd } } }, { $group: { _id: { $cond: [{ $gte: ['$date', currentStart] }, 'current', 'previous'] }, count: { $sum: 1 } } }],
      } }])
      const [users, active, completed, pendingReview, upcoming, pendingBusinesses, pendingPosts, userSummary, activitySummary, categories, businessItems, postItems, upcomingItems, adminCount, businessOwners, hostOwners] = await Promise.all([
        count('users', alive), count('activities', { ...alive, status: 'in-progress' }), count('activities', { ...alive, status: 'completed' }), count('activities', { ...alive, status: 'pending-review' }), count('activities', upcomingFilter),
        count('business_applications', { ...alive, status: 'pending' }), count('business_posts', { ...alive, status: 'pending' }), summary('users'), summary('activities'),
        aggregate(db, 'activities', [{ $match: visible }, { $group: { _id: { $ifNull: ['$category', 'Other'] }, count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }, { $limit: 20 }, { $project: { _id: 0, category: '$_id', count: 1 } }]),
        db.collection('business_applications').find({ ...alive, status: 'pending' }, { projection: { _id: 0, id: 1, ownerId: 1, company: 1, category: 1, createdAt: 1, status: 1 } }).sort({ createdAt: 1, id: 1 }).limit(5).toArray(),
        db.collection('business_posts').find({ ...alive, status: 'pending' }, { projection: { _id: 0, id: 1, ownerId: 1, title: 1, businessName: 1, createdAt: 1, status: 1 } }).sort({ createdAt: 1, id: 1 }).limit(5).toArray(),
        db.collection('activities').find(upcomingFilter, { projection: { _id: 0, id: 1, title: 1, hostName: 1, category: 1, startsAt: 1, location: 1, status: 1 } }).sort({ startsAt: 1, id: 1 }).limit(5).toArray(),
        count('users', { ...alive, role: 'admin' }), db.collection('business_applications').distinct('ownerId', { ...alive, status: 'approved' }), db.collection('activities').distinct('hostId', { ...visible, organizerType: { $ne: 'business' } }),
      ])
      const [business, host] = await Promise.all([
        count('users', { ...alive, role: { $ne: 'admin' }, id: { $in: businessOwners } }),
        count('users', { ...alive, role: { $ne: 'admin' }, id: { $in: hostOwners, $nin: businessOwners } }),
      ])
      const growth = data => { const current = data[0]?.growth.find(row => row._id === 'current')?.count ?? 0, previous = data[0]?.growth.find(row => row._id === 'previous')?.count ?? 0; return { current, previous, percentage: percentage(current, previous) } }
      const recentSources = [['users', 'user-registered', 'name', 'id'], ['business_applications', 'business-submitted', 'company', 'ownerId'], ['business_posts', 'post-created', 'title', 'ownerId'], ['activities', 'activity-created', 'title', 'hostId']]
      const recent = await Promise.all(recentSources.map(([name, kind, detail, actor]) => aggregate(db, name, [{ $match: name === 'users' ? alive : visible }, { $set: { date: created } }, { $sort: { date: -1, id: 1 } }, { $limit: 10 }, { $project: { _id: 0, id: 1, kind: { $literal: kind }, actorId: '$' + actor, actorName: { $ifNull: ['$hostName', { $ifNull: ['$businessName', '$name'] }] }, detail: '$' + detail, status: 1, createdAt: '$date' } }])))
      const buckets = Array.from({ length: days }, (_, index) => {
        const start = new Date(+trendStart + index * day), key = localDate(start)
        return { start: start.toISOString(), label: key.slice(5), users: userSummary[0]?.trend.find(row => row._id === key)?.count ?? 0, activities: activitySummary[0]?.trend.find(row => row._id === key)?.count ?? 0 }
      })
      return { users, usersByRole: { member: users - adminCount - business - host, host, business, admin: adminCount }, activities: { active, completed, pendingReview, upcoming }, pendingBusinesses, pendingPosts, trend: { period, buckets }, growth: { users: growth(userSummary), activities: growth(activitySummary) }, pendingBusinessItems: businessItems, pendingPostItems: postItems, upcomingActivityItems: upcomingItems, activityCategories: categories, recentActivity: recent.flat().sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0) || a.id.localeCompare(b.id)).slice(0, 10) }
    },
    async performance() {
      const [attendance, posts, cancellations, regions] = await Promise.all([
        aggregate(db, 'activities', [{ $match: visible }, { $unwind: '$attendance' }, { $match: { 'attendance.status': { $in: ['present', 'late'] } } }, { $group: { _id: '$attendance.status', count: { $sum: 1 } } }]),
        aggregate(db, 'business_posts', [{ $match: visible }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
        count('activities', { ...alive, organizerType: 'business', status: 'cancelled' }),
        aggregate(db, 'activities', [
          { $match: visible },
          { $set: { regionCity: { $trim: { input: { $ifNull: ['$province', { $ifNull: ['$city', ''] }] } } }, regionDistrict: { $trim: { input: { $ifNull: ['$district', ''] } } } } },
          { $match: { regionCity: { $ne: '' } } },
          { $set: { regionCity: { $switch: { branches: [
            { case: { $in: [{ $toLower: '$regionCity' }, ['tp.hcm', 'tp. hcm', 'tphcm', 'hcm', 'hồ chí minh', 'thành phố hồ chí minh', 'tp. hồ chí minh', 'tp hồ chí minh', 'ho chi minh city', 'ho chi minh']] }, then: 'TP. Hồ Chí Minh' },
            { case: { $in: [{ $toLower: '$regionCity' }, ['hà nội', 'thành phố hà nội', 'ha noi', 'hanoi', 'hanoi city']] }, then: 'Hà Nội' },
            { case: { $in: [{ $toLower: '$regionCity' }, ['đà nẵng', 'thành phố đà nẵng', 'da nang', 'danang', 'da nang city']] }, then: 'Đà Nẵng' },
          ], default: '$regionCity' } } } },
          { $facet: {
            cities: [{ $group: { _id: '$regionCity', activityCount: { $sum: 1 }, participantCount: { $sum: { $ifNull: ['$memberCount', 0] } } } }, { $sort: { activityCount: -1, _id: 1 } }, { $limit: 5 }, { $project: { _id: 0, name: '$_id', area: { $literal: '' }, activityCount: 1, participantCount: 1 } }],
            districts: [{ $match: { regionDistrict: { $ne: '' } } }, { $group: { _id: { name: '$regionDistrict', area: '$regionCity' }, activityCount: { $sum: 1 }, participantCount: { $sum: { $ifNull: ['$memberCount', 0] } } } }, { $sort: { activityCount: -1, '_id.area': 1, '_id.name': 1 } }, { $limit: 5 }, { $project: { _id: 0, name: '$_id.name', area: '$_id.area', activityCount: 1, participantCount: 1 } }],
          } },
        ]),
      ])
      const late = attendance.find(row => row._id === 'late')?.count ?? 0, present = attendance.find(row => row._id === 'present')?.count ?? 0
      const rejected = posts.find(row => row._id === 'rejected')?.count ?? 0, withdrawn = posts.find(row => row._id === 'withdrawn')?.count ?? 0
      // Count post entries and activity entries as separate populations, avoiding a rate above 100%.
      const activityTotal = await count('activities', { ...visible, organizerType: 'business' })
      const total = posts.reduce((sum, row) => sum + row.count, 0) + activityTotal, cancelledOrRejected = rejected + withdrawn + cancellations
      return { lateArrival: { late, present, total: late + present, rate: late + present ? late / (late + present) * 100 : 0 }, businessCancellation: { total, rejected, withdrawn, cancelledActivities: cancellations, cancelledOrRejected, rate: total ? cancelledOrRejected / total * 100 : 0 }, topLocations: regions[0]?.cities ?? [], topCities: regions[0]?.cities ?? [], topDistricts: regions[0]?.districts ?? [] }
    },
    async revenue({ type, year, month, businessId }) {
      const business = businessId ? await db.collection('business_applications').findOne({ id: businessId }, { projection: { _id: 0, id: 1, ownerId: 1, company: 1, status: 1 } }) : null
      if (businessId && !business) throw new HttpError(404, 'Không tìm thấy doanh nghiệp')
      if (business && typeof business.ownerId !== 'string') throw new HttpError(409, 'Hồ sơ thiếu tài khoản doanh nghiệp')
      const scope = business ? { ownerId: business.ownerId } : {}
      const start = startOfMonth(year, type === 'monthly' ? month : 1), end = startOfMonth(type === 'monthly' ? year : year + 1, type === 'monthly' ? month + 1 : 1)
      const previousStart = startOfMonth(type === 'monthly' ? year : year - 1, type === 'monthly' ? month - 1 : 1)
      const rows = await aggregate(db, 'finance_escrows', [
        { $match: { ...scope, payouts: { $elemMatch: { status: 'completed', processedAt: { $gte: previousStart, $lt: end } } } } },
        { $unwind: '$payouts' }, { $match: { 'payouts.status': 'completed', 'payouts.processedAt': { $gte: previousStart, $lt: end } } },
        { $group: { _id: { $dateToString: { date: '$payouts.processedAt', format: type === 'monthly' ? '%Y-%m-%d' : '%Y-%m', timezone: zone } }, revenue: { $sum: '$payouts.feeAmount' }, settledPayouts: { $sum: '$payouts.amount' }, transactions: { $sum: 1 } } },
      ])
      const length = type === 'monthly' ? Math.round((+end - +start) / day) : 12
      const buckets = Array.from({ length }, (_, index) => {
        const key = type === 'monthly' ? localDate(new Date(+start + index * day)) : `${year}-${String(index + 1).padStart(2, '0')}`
        const row = rows.find(row => row._id === key)
        return { key, label: String(index + 1), revenue: row?.revenue ?? 0, settledPayouts: row?.settledPayouts ?? 0, transactions: row?.transactions ?? 0 }
      })
      const currentKey = localDate(start).slice(0, type === 'monthly' ? 10 : 7)
      const previousRevenue = rows.filter(row => row._id < currentKey).reduce((sum, row) => sum + row.revenue, 0)
      const totalRevenue = buckets.reduce((sum, row) => sum + row.revenue, 0)
      let businessSummary
      if (business) {
        const [summary] = await aggregate(db, 'finance_escrows', [{ $match: scope }, { $facet: {
          deposits: [{ $unwind: '$lots' }, { $group: { _id: null,
            receivedDeposits: { $sum: { $cond: [{ $and: [{ $gte: ['$lots.verifiedAt', start] }, { $lt: ['$lots.verifiedAt', end] }] }, '$lots.amount', 0] } },
            refundedDeposits: { $sum: { $cond: [{ $and: [{ $eq: ['$lots.refund.status', 'completed'] }, { $gte: ['$lots.refund.completedAt', start] }, { $lt: ['$lots.refund.completedAt', end] }] }, '$lots.refund.amount', 0] } },
            currentHeld: { $sum: { $cond: [{ $in: ['$lots.state', ['held', 'disputed', 'refund_requested', 'refund_approved', 'payout_reserved']] }, '$lots.amount', 0] } },
          } }],
          pending: [{ $unwind: '$payouts' }, { $match: { 'payouts.status': { $in: ['pending', 'approved', 'processing'] } } }, { $group: { _id: null, amount: { $sum: '$payouts.amount' } } }],
        } }])
        businessSummary = { receivedDeposits: summary.deposits[0]?.receivedDeposits ?? 0, refundedDeposits: summary.deposits[0]?.refundedDeposits ?? 0, currentHeld: summary.deposits[0]?.currentHeld ?? 0, currentPendingPayouts: summary.pending[0]?.amount ?? 0 }
      }
      return { type, year, ...(month ? { month } : {}), ...(business ? { business, businessSummary } : {}), currency: 'VND', totalRevenue, previousRevenue, growthPercentage: percentage(totalRevenue, previousRevenue), comparison: type === 'monthly' ? 'MoM' : 'YoY', settledPayouts: buckets.reduce((sum, row) => sum + row.settledPayouts, 0), transactions: buckets.reduce((sum, row) => sum + row.transactions, 0), buckets, sources: [{ key: 'payout-fees', label: 'Completed payout fees', amount: totalRevenue }] }
    },
  }
}
