import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { newToken, hashToken } from '../src/modules/auth/token.js'
import { ensureWorkshopAdmin } from '../src/database/workshop-demo-admin.js'

test('only Admin moderates; business staff and legacy staff cannot acquire moderation privileges', async t => {
  const mongo = await MongoMemoryServer.create(); t.after(() => mongo.stop())
  const client = createClient(readConfig({ MONGODB_URI: mongo.getUri('portal_authority') })); await client.connect(); t.after(() => client.close())
  const db = client.db(); await initializeDatabase(db)
  const auth = createAuthRepository(db), users = [], tokens = []
  for (const [index, role] of ['staff', 'admin', 'user', 'user'].entries()) {
    const user = await auth.createUser({ name: 'Authority ' + index, email: `authority${index}@example.com`, passwordHash: 'hash' }); users.push(user)
    await db.collection('users').updateOne({ id: user.id }, { $set: { role, email_verified: true } })
    const token = newToken(); tokens.push(token); await auth.createSession({ userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 600000) })
  }
  await db.collection('business_applications').insertMany([{ id: 'owner', ownerId: users[2].id, company: 'Owner', status: 'approved' }, { id: 'pending', ownerId: 'applicant', company: 'Applicant', status: 'pending', version: 1 }])
  await db.collection('business_staff').insertOne({ id: 'employee', ownerId: users[2].id, userId: users[3].id, status: 'approved', acceptedAt: new Date(), groupIds: [] })
  await db.collection('business_posts').insertOne({ id: 'post', ownerId: users[2].id, status: 'pending', version: 1 })
  const server = createApp(readConfig({}), { authRepository: auth }).listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)))
  const call = async (who, path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/portal${path}`, { method: body ? 'PATCH' : 'GET', headers: { Authorization: 'Bearer ' + tokens[who], 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, body: await response.json() }
  }
  assert.equal((await call(0, '/me')).body.role, 'user')
  assert.equal((await call(3, '/me')).body.role, 'business-staff')
  for (const who of [0, 3]) {
    for (const path of ['/applications', '/reports', '/users', '/metrics']) assert.equal((await call(who, path)).status, 403)
    assert.equal((await call(who, '/applications/pending', { status: 'approved', version: 1 })).status, 403)
    assert.equal((await call(who, '/posts/post', { status: 'approved', version: 1 })).status, 403)
  }
  assert.equal((await call(1, '/applications/pending', { status: 'approved', version: 1 })).status, 200)
  assert.equal((await call(1, '/posts/post', { status: 'approved', version: 1 })).status, 200)
  assert.equal((await call(1, `/users/${users[0].id}/role`, { role: 'staff' })).status, 400)
  assert.equal((await call(1, '/users')).body.items.find(row => row.id === users[0].id).effectiveRole, 'user')
  const legacy = { id: 'legacy-demo', email: 'demo.staff@gomate.local', demoScenario: 'workshop', role: 'staff', password_hash: 'preserved-password-hash', credential_version: 0 }
  await db.collection('users').insertOne(legacy)
  const admin = await ensureWorkshopAdmin(db)
  assert.equal(admin.id, legacy.id); assert.equal(admin.email, 'demo.admin@gomate.local'); assert.equal(admin.role, 'admin'); assert.equal(admin.password_hash, legacy.password_hash); assert.equal(admin.credential_version, 1)
  assert.equal((await ensureWorkshopAdmin(db)).credential_version, 1)
  await db.collection('users').updateOne({ id: admin.id }, { $unset: { demoScenario: '' } })
  await assert.rejects(ensureWorkshopAdmin(db), /non-demo/)
})
