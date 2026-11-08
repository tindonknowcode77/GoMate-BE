export async function staffGroupScope(db, userId) {
  const grants = await db.collection('business_staff').find({ userId, status: 'approved', $or: [{ provisionedAt: { $ne: null } }, { acceptedAt: { $ne: null } }] }).toArray()
  const businesses = await db.collection('business_applications').find({ ownerId: { $in: grants.map(row => row.ownerId) }, status: 'approved' }, { projection: { ownerId: 1 } }).toArray()
  const owners = new Set(businesses.map(row => row.ownerId))
  const scopes = grants.filter(row => owners.has(row.ownerId)).map(row => ({ hostId: row.ownerId, id: { $in: row.groupIds }, organizerType: 'business' }))
  return { status: { $nin: ['deleted', 'pending-review'] }, $or: scopes.length ? scopes : [{ id: { $in: [] } }] }
}

export async function isAssignedStaff(db, userId, activityId) {
  return Boolean(await db.collection('activities').findOne({ $and: [{ id: activityId }, await staffGroupScope(db, userId)] }, { projection: { id: 1 } }))
}

export async function isStaffAccount(db, userId) {
  const user = await db.collection('users').findOne({ id: userId }, { projection: { businessManagedBy: 1 } })
  if (user?.businessManagedBy) return true
  const grants = await db.collection('business_staff').find({ userId, status: 'approved', $or: [{ provisionedAt: { $ne: null } }, { acceptedAt: { $ne: null } }] }, { projection: { ownerId: 1 } }).toArray()
  if (!grants.length) return false
  return Boolean(await db.collection('business_applications').findOne({ ownerId: { $in: grants.map(row => row.ownerId) }, status: 'approved' }, { projection: { _id: 1 } }))
}

export async function listAssignedStaff(db, activity) {
  if (activity.organizerType !== 'business') return []
  return db.collection('business_staff').find({ ownerId: activity.hostId, groupIds: activity.id, status: 'approved', $or: [{ provisionedAt: { $ne: null } }, { acceptedAt: { $ne: null } }] }, { projection: { _id: 0, userId: 1, name: 1, title: 1 } }).sort({ createdAt: 1, id: 1 }).toArray()
}
