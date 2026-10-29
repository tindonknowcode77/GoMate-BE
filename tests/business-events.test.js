import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { seedWorkshopDemo } from '../src/database/workshop-demo.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { createActivityRepository } from '../src/modules/activities/repository.js'
import { createChatRepository } from '../src/modules/chat/repository.js'
import { newToken, hashToken } from '../src/modules/auth/token.js'

test('verified business events publish through staff, reach discovery and preserve membership permissions', async t => {
  const mongo = await MongoMemoryServer.create(); t.after(() => mongo.stop())
  const client = createClient(readConfig({ MONGODB_URI: mongo.getUri('business_events') })); await client.connect(); t.after(() => client.close())
  const db = client.db(); await initializeDatabase(db)
  const seeded = await seedWorkshopDemo(db), repeated = await seedWorkshopDemo(db)
  assert.equal(seeded.personalId, repeated.personalId); assert.equal(seeded.businessId, repeated.businessId)
  assert.equal(await db.collection('users').countDocuments({ demoScenario: 'workshop' }), 5)
  const auth = createAuthRepository(db), activities = createActivityRepository(db), chat = createChatRepository(db), tokens = {}, people = {}
  for (const key of ['business', 'staff', 'member', 'newbusiness']) {
    people[key] = await db.collection('users').findOne({ email: `demo.${key}@gomate.local` }); tokens[key] = newToken()
    await auth.createSession({ userId: people[key].id, tokenHash: hashToken(tokens[key]), expiresAt: new Date(Date.now() + 600000) })
  }
  const server = createApp(readConfig({}), { authRepository: auth, activityRepository: activities, chatRepository: chat }).listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)))
  const req = async (path, method = 'GET', body, key = 'business') => {
    if (method === 'PATCH' && body?.status && /\/(applications|posts)\/[^/]+$/.test(path) && !('version' in body)) {
      const parts = path.split('/'); const row = await db.collection(parts.at(-2) === 'applications' ? 'business_applications' : 'business_posts').findOne({id:parts.at(-1)}); body = {...body,version:row?.version ?? 1};
    }
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { Authorization: 'Bearer ' + tokens[key], 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: response.status === 204 ? null : await response.json() }
  }
  const options = await req('/portal/options'); assert.equal(options.status, 200); assert.ok(options.body.activityCategories.includes('Workshop'));
  const post = { title: 'Business Publication Contract', copy: 'A verified event with a real approved schedule', premium: false, border: 'Solid', badge: 'Verified', discount: 'Giảm 25%', discountPercent: 25, offer: 'Tặng đồ uống', offerTerms: 'Một lần cho mỗi người', event: { category: 'Workshop', location: 'TP. Hồ Chí Minh', startsAt: '2099-01-01T02:00:00Z', endsAt: '2099-01-01T04:00:00Z', estimatedCost: 75000, maxParticipants: 5, plan: ['Welcome', 'Workshop', 'Summary'] } }
  assert.equal((await req('/portal/posts', 'POST', post, 'newbusiness')).status, 403)
  assert.equal((await req('/portal/posts', 'POST', { ...post, discountPercent: 101 })).status, 400)
  assert.equal((await req('/portal/posts', 'POST', { ...post, event: { ...post.event, initialFriendIds: [people.member.id] } })).status, 400)
  assert.equal((await req('/activities', 'POST', { ...post.event, title: post.title, description: post.copy, business: { verified: true } }, 'member')).status, 400)
  const created = await req('/portal/posts', 'POST', post); assert.equal(created.status, 201)
  assert.equal((await req('/activities?q=Business%20Publication', 'GET', undefined, 'member')).body.total, 0)
  assert.equal((await req(`/portal/posts/${created.body.id}`, 'PATCH', { status: 'approved' }, 'member')).status, 403)
  assert.equal((await req(`/portal/posts/${created.body.id}`, 'PATCH', { status: 'approved' }, 'staff')).status, 200)
  assert.equal((await req(`/portal/posts/${created.body.id}`, 'PATCH', { status: 'approved' }, 'staff')).status, 409)
  const found = await req('/activities?q=Business%20Publication&organizerType=business', 'GET', undefined, 'member')
  assert.equal(found.body.total, 1)
  const activity = found.body.items[0]; assert.equal(activity.id, created.body.activityId); assert.equal(activity.business.verified, true); assert.equal(activity.business.discountPercent, 25); assert.equal(activity.hostName, 'GoMate Studio · Demo')
  assert.equal((await req('/activities/' + activity.id)).body.activity.scheduleConfirmedAt, null)
  assert.equal((await req('/activities/' + activity.id, 'PATCH', { title: 'Bypass review' })).status, 403)
  assert.equal((await req(`/activities/${activity.id}/members/friends`, 'POST', { friendIds: [people.member.id], useReservedSeats: false })).status, 403)
  assert.equal((await req(`/activities/${activity.id}/companions`, 'PATCH', { version: activity.version, companions: [] })).status, 403)
  const joined = await req(`/activities/${activity.id}/join-requests`, 'POST', {}, 'member'); assert.equal(joined.status, 201)
  assert.equal((await req(`/activities/${activity.id}/join-requests/${joined.body.request.id}`, 'PATCH', { status: 'approved' }, 'staff')).status, 403)
  assert.equal((await req(`/activities/${activity.id}/join-requests/${joined.body.request.id}`, 'PATCH', { status: 'approved' })).status, 200)
  assert.equal((await req('/conversations', 'POST', { type: 'group', activityId: activity.id }, 'member')).status, 200)
  assert.equal((await req(`/activities/${activity.id}/start`, 'POST', {})).status, 409)
  assert.equal((await req(`/activities/${activity.id}/confirm-schedule`, 'POST', {version: (await req('/activities/'+activity.id)).body.activity.version})).status, 200)
  assert.equal((await req(`/activities/${activity.id}/start`, 'POST', {})).status, 200)
  for (const key of ['member', 'business']) assert.equal((await req(`/activities/${activity.id}/attendance/${people[key].id}`, 'PATCH', { status: 'present' })).status, 200)
  assert.equal((await req(`/activities/${activity.id}/complete`, 'POST', {})).status, 200)
  assert.equal((await req(`/community/ratings/${activity.id}`, 'POST', { score: 5, comment: 'Great event', members: [{ userId: people.business.id, score: 5 }] }, 'member')).status, 200)
})
