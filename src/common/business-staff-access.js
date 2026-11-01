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
