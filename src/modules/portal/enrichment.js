import { createPostDetails } from './post-details.js'

export function createPortalEnrichment(db) {
  const users = db.collection('users')
  const applications = db.collection('business_applications')
  const bankAccounts = db.collection('business_bank_accounts')
  const details = createPostDetails(db)

  async function enrichBusinesses(rows) {
    if (!rows.length) return rows
    const userIds = [...new Set(rows.flatMap(row => [row.ownerId, row.reviewedBy]).filter(Boolean))]
    const ownerIds = [...new Set(rows.map(row => row.ownerId).filter(Boolean))]
    const [people, banks] = await Promise.all([
      userIds.length ? users.find({ id: { $in: userIds } }, { projection: { _id: 0, id: 1, name: 1, email: 1, email_verified: 1, subscription: 1 } }).toArray() : [],
      ownerIds.length ? bankAccounts.find({ ownerId: { $in: ownerIds } }, { projection: { _id: 0, ownerId: 1, bankId: 1, accountNo: 1, accountName: 1, branch: 1, updatedAt: 1 } }).toArray() : [],
    ])
    const userMap = new Map(people.map(user => [user.id, user]))
    const bankMap = new Map(banks.map(bank => [bank.ownerId, bank]))
    return rows.map(row => {
      const owner = userMap.get(row.ownerId)
      const reviewer = row.reviewedBy ? userMap.get(row.reviewedBy) : null
      const bank = bankMap.get(row.ownerId)
      return {
        ...row,
        ownerName: owner?.name ?? null,
        ownerEmail: owner?.email ?? null,
        ownerEmailVerified: Boolean(owner?.email_verified),
        ownerSubscription: owner?.subscription ?? null,
        reviewerName: reviewer?.name ?? null,
        bankAccount: bank ? {
          bankId: bank.bankId,
          accountNo: bank.accountNo,
          accountName: bank.accountName,
          branch: bank.branch || '',
          updatedAt: bank.updatedAt ?? null,
        } : null,
      }
    })
  }

  async function enrichPosts(rows) {
    if (!rows.length) return rows
    const hydrated = await details.hydrate(rows)
    const ownerIds = [...new Set(hydrated.map(row => row.ownerId).filter(Boolean))]
    const userIds = [...new Set(hydrated.flatMap(row => [row.ownerId, row.reviewedBy]).filter(Boolean))]
    const [apps, people] = await Promise.all([
      ownerIds.length ? applications.find({ ownerId: { $in: ownerIds }, status: { $ne: 'deleted' } }, {
        projection: {
          _id: 0, id: 1, ownerId: 1, company: 1, category: 1, address: 1, website: 1, status: 1,
          taxId: 1, certificateNumber: 1, representativeName: 1, representativeTitle: 1,
          representativeEmail: 1, representativePhone: 1,
        },
      }).toArray() : [],
      userIds.length ? users.find({ id: { $in: userIds } }, { projection: { _id: 0, id: 1, name: 1, email: 1 } }).toArray() : [],
    ])
    const appMap = new Map(apps.map(app => [app.ownerId, app]))
    const userMap = new Map(people.map(user => [user.id, user]))
    return hydrated.map(row => {
      const app = appMap.get(row.ownerId)
      const owner = userMap.get(row.ownerId)
      const reviewer = row.reviewedBy ? userMap.get(row.reviewedBy) : null
      const resolvedBusinessName = app?.company || row.businessName || owner?.name || 'Doanh nghiệp'
      return {
        ...row,
        businessId: app?.id ?? null,
        businessName: resolvedBusinessName,
        ownerName: owner?.name ?? null,
        ownerEmail: owner?.email ?? null,
        reviewerName: reviewer?.name ?? null,
        business: app ? {
          id: app.id,
          company: app.company,
          category: app.category || '',
          address: app.address || '',
          website: app.website || '',
          status: app.status,
          taxId: app.taxId || '',
          certificateNumber: app.certificateNumber || '',
          representativeName: app.representativeName || '',
          representativeTitle: app.representativeTitle || '',
          representativeEmail: app.representativeEmail || '',
          representativePhone: app.representativePhone || '',
        } : null,
      }
    })
  }

  return { enrichBusinesses, enrichPosts }
}
