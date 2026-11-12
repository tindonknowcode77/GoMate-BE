import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { createActivityRepository } from '../src/modules/activities/repository.js'
import { createPaymentRepository } from '../src/modules/payment/repository.js'
import { createPostDetails } from '../src/modules/portal/post-details.js'
import { hashToken, newToken } from '../src/modules/auth/token.js'

test('business settings enforce owner access, atomic auto approval, current deposit quotes and approved-post edits', async t => {
  const mongo = await MongoMemoryServer.create(); t.after(() => mongo.stop())
  const client = createClient(readConfig({ MONGODB_URI: mongo.getUri('business_settings') })); await client.connect(); t.after(() => client.close())
  const db = client.db(); await initializeDatabase(db)
  const auth = createAuthRepository(db), repo = createActivityRepository(db), users = [], tokens = []
  for (let i = 0; i < 7; i++) {
    const user = await auth.createUser({ name: `Settings ${i}`, email: `settings${i}@example.com`, passwordHash: 'unused' }); users.push(user)
    await db.collection('users').updateOne({ id: user.id }, { $set: { role: i === 1 ? 'admin' : 'user', email_verified: true, birthDate: '2000-01-01', gender: 'other', languages: ['Tiếng Việt'] } })
    const token = newToken(); tokens.push(token); await auth.createSession({ userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 600000) })
  }
  await db.collection('business_applications').insertMany([0, 6].map(i => ({ id: `settings-biz-${i}`, ownerId: users[i].id, company: `Settings business ${i}`, status: 'approved' })))
  const server = createApp(readConfig({}), { authRepository: auth, activityRepository: repo }).listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)))
  const call = async (who, path, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: response.status === 204 ? null : await response.json() }
  }
  const ok = (value, status = 200) => { assert.equal(value.status, status, JSON.stringify(value.body)); return value.body }
  const event = { category: 'Workshop', location: '12 Nguyen Hue', startsAt: new Date(Date.now() + 86400000).toISOString(), endsAt: new Date(Date.now() + 93600000).toISOString(), maxParticipants: 2, estimatedCost: 100000 }
  let post = ok(await call(0, '/portal/posts', 'POST', { title: 'Settings workshop', copy: 'Before edit', premium: false, border: 'Solid', groups: [{ name: 'Settings group', depositAmount: 50000, event }] }), 201)
  post = ok(await call(1, `/portal/posts/${post.id}`, 'PATCH', { version: post.version, status: 'approved' }))
  const id = post.groups[0].activityId, path = `/portal/groups/${id}/settings`
  let group = ok(await call(0, `/portal/groups/${id}`))
  ok(await call(2, path, 'PATCH', { version: group.version, autoApproveMembers: true }), 403)
  ok(await call(6, path, 'PATCH', { version: group.version, autoApproveMembers: true }), 403)
  ok(await call(0, path, 'PATCH', { version: group.version, autoApproveMembers: 'yes' }), 400)
  group = ok(await call(0, path, 'PATCH', { version: group.version, autoApproveMembers: true }))
  const joined = ok(await call(2, `/activities/${id}/join-requests`, 'POST', {}), 201)
  assert.equal(joined.request.status, 'approved')
  const concurrent = await Promise.all([3, 4, 5].map(i => repo.submitJoinRequest(id, users[i])))
  assert.equal(concurrent.filter(Boolean).length, 1, 'capacity cannot be exceeded by concurrent automatic joins')
  let activity = await repo.get(id); assert.equal(activity.memberCount, 2)
  assert.equal(activity.joinRequests.filter(row => row.status === 'approved').length, 2)
  ok(await call(2, `/activities/${id}/join-requests`, 'POST', {}), 409)
  group = ok(await call(0, `/portal/groups/${id}`))
  ok(await call(0, path, 'PATCH', { version: group.version - 1, autoApproveMembers: false }), 409)
  group = ok(await call(0, path, 'PATCH', { version: group.version, autoApproveMembers: false }))
  await db.collection('activities').updateOne({ id }, { $set: { maxParticipants: 10 } })
  const notJoined = [3, 4, 5].find(i => !activity.joinRequests.some(row => row.userId === users[i].id))
  assert.equal(ok(await call(notJoined, `/activities/${id}/join-requests`, 'POST', {}), 201).request.status, 'pending')
  await db.collection('activities').updateOne({ id }, { $set: { businessReceipts: [{ userId: users[2].id, status: 'paid', amount: 50000, method: 'vietqr', paymentId: 'paid-settings' }] } })
  await db.collection('payments').insertMany([{ id: 'paid-settings', orderCode: 'GM001001', activityId: id, userId: users[2].id, type: 'activity_deposit', amount: 50000, status: 'paid' }, { id: 'pending-settings', orderCode: 'GM001002', activityId: id, userId: users[notJoined].id, type: 'activity_deposit', amount: 50000, status: 'pending' }])
  group = ok(await call(0, `/portal/groups/${id}`))
  ok(await call(0, path, 'PATCH', { version: group.version, depositAmount: 100001 }), 400)
  assert.equal((await repo.get(id)).version, group.version)
  group = ok(await call(0, path, 'PATCH', { version: group.version, depositAmount: 70000 }))
  assert.equal(group.depositChangeRequest?.status, 'pending')
  assert.equal(group.depositChangeRequest?.requestedAmount, 70000)
  // Admin approves the deposit change
  group = ok(await call(1, `/portal/groups/${id}/deposit-change`, 'PATCH', { status: 'approved', note: 'Duyet thay doi muc coc' }))
  assert.equal(group.depositAmount, 70000)
  assert.equal(group.depositMembers.find(row => row.id === users[2].id).amount, 50000)
  assert.equal(group.depositMembers.find(row => row.id === users[2].id).status, 'paid')
  assert.equal((await db.collection('payments').findOne({ id: 'pending-settings' })).status, 'cancelled')
  const payments = createPaymentRepository(db)
  assert.equal((await payments.findPaymentById('paid-settings')).verification, undefined)
  assert.equal(ok(await call(0, '/portal/posts')).items[0].groups[0].depositAmount, 70000)
  const details = { version: post.version, title: 'Edited approved workshop', copy: 'New public copy', discountPercent: 15, offer: 'Coffee', offerTerms: 'One per member' }
  ok(await call(6, `/portal/posts/${post.id}/details`, 'PATCH', details), 404)
  ok(await call(0, `/portal/posts/${post.id}/details`, 'PATCH', { ...details, status: 'approved' }), 400)
  const edited = ok(await call(0, `/portal/posts/${post.id}/details`, 'PATCH', details))
  assert.equal(edited.status, 'approved'); assert.equal(edited.version, post.version + 1)
  activity = await repo.get(id)
  assert.equal(activity.title, details.title); assert.equal(activity.description, details.copy)
  assert.equal(activity.business.offer, 'Coffee'); assert.equal(activity.depositAmount, 70000)
  assert.equal(activity.businessReceipts[0].amount, 50000); assert.equal(activity.autoApproveMembers, false)
  ok(await call(0, `/portal/posts/${post.id}/details`, 'PATCH', details), 409)
  // A delayed retry of an older edit cannot overwrite a newer edit.
  const newer = ok(await call(0, `/portal/posts/${post.id}/details`, 'PATCH', { ...details, version: edited.version, title: 'Newest title' }))
  await createPostDetails(db).reconcile({ id: post.id, contentSync: { ...details, version: edited.version } })
  assert.equal((await repo.get(id)).title, newer.title)
  const interrupted = createPostDetails({ collection: name => {
    const collection = db.collection(name)
    return name === 'activities' ? { updateMany: async () => { throw Error('simulated network interruption') } } : collection
  } })
  const { version: _version, ...content } = details
  await assert.rejects(() => interrupted.edit(post.id, users[0].id, newer.version, { ...content, title: 'Recovered after interruption' }), /simulated network/)
  assert.ok((await db.collection('business_posts').findOne({ id: post.id })).contentSync)
  await auth.portal.reconcilePublications()
  assert.equal((await repo.get(id)).title, 'Recovered after interruption')
  assert.equal((await db.collection('business_posts').findOne({ id: post.id })).contentSync, undefined)
  await db.collection('activities').updateOne({ id }, { $set: { status: 'in-progress' } })
  group = ok(await call(0, `/portal/groups/${id}`))
  ok(await call(0, path, 'PATCH', { version: group.version, depositAmount: 80000 }), 409)
  assert.equal((await repo.get(id)).depositAmount, 70000)
})
