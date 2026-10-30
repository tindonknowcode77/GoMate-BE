import { createAuthRepository } from '../modules/auth/repository.js'
import { hashPassword } from '../modules/auth/password.js'

// Only explicitly marked workshop demo identities may be migrated.
export async function ensureWorkshopAdmin(db, { password = 'DemoGoMate123!' } = {}) {
  if (process.env.NODE_ENV === 'production') throw Error('Workshop demo changes are disabled in production')
  const users = db.collection('users'), email = 'demo.admin@gomate.local'
  let admin = await users.findOne({ email })
  if (admin && admin.demoScenario !== 'workshop') throw Error('Refusing to change an existing non-demo administrator account')
  const legacy = await users.findOne({ email: 'demo.staff@gomate.local', demoScenario: 'workshop' })
  if (!admin && legacy) {
    await users.updateOne({ id: legacy.id, demoScenario: 'workshop' }, { $set: { email, name: 'Linh · Demo Admin', role: 'admin', username: 'gomate_demo_admin' }, $inc: { credential_version: 1 } })
    admin = await users.findOne({ id: legacy.id })
  }
  if (!admin) {
    const auth = createAuthRepository(db)
    admin = await auth.createUser({ name: 'Linh · Demo Admin', email, passwordHash: await hashPassword(password) })
    await users.updateOne({ id: admin.id }, { $set: { demoScenario: 'workshop', role: 'admin', email_verified: true, username: 'gomate_demo_admin' } })
    admin = await users.findOne({ id: admin.id })
  } else if (admin.role !== 'admin') {
    await users.updateOne({ id: admin.id, demoScenario: 'workshop' }, { $set: { role: 'admin' }, $inc: { credential_version: 1 } })
    admin = await users.findOne({ id: admin.id })
  }
  if (legacy && legacy.id !== admin.id && legacy.role === 'staff') await users.updateOne({ id: legacy.id, demoScenario: 'workshop', role: 'staff' }, { $set: { role: 'user' }, $inc: { credential_version: 1 } })
  return admin
}
