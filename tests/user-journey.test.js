import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { createActivityRepository } from '../src/modules/activities/repository.js'
import { createChatRepository } from '../src/modules/chat/repository.js'
import { hashToken, newToken } from '../src/modules/auth/token.js'

test('independent accounts discover, consent to invites, qualify, attend, rate and become friends', async t => {
  const mongo = await MongoMemoryServer.create(); t.after(() => mongo.stop())
  const client = createClient(readConfig({ MONGODB_URI: mongo.getUri('user_journey') }))
  await client.connect(); t.after(() => client.close())
  const db = client.db(); await initializeDatabase(db)
  const auth = createAuthRepository(db), repository = createActivityRepository(db)
  const users = [], tokens = []
  for (let index = 0; index < 5; index++) {
    const user = await auth.createUser({ name: 'Journey ' + index, email: `journey${index}@example.com`, passwordHash: 'unused' })
    await db.collection('users').updateOne({ id: user.id }, { $set: { email_verified: true, birthDate: '2000-01-01', gender: 'other', languages: ['Tiếng Việt'] } })
    users.push(user); tokens.push(newToken())
    await auth.createSession({ userId: user.id, tokenHash: hashToken(tokens[index]), expiresAt: new Date(Date.now() + 600000) })
  }
  for (const index of [1, 2]) { const request = await auth.friendRequest(users[0].id, users[index].id); await auth.decideFriend(users[index].id, request.id, 'accepted') }
  const server = createApp(readConfig({}), { authRepository: auth, activityRepository: repository, chatRepository: createChatRepository(db) }).listen(0, '127.0.0.1')
  await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)))
  const call = async (index, path, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { Authorization: 'Bearer ' + tokens[index], 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: response.status === 204 ? null : await response.json() }
  }
  const draft = { title: 'Journey public activity', description: 'Cross-account trip', category: 'Cà phê', location: 'Hà Nội', startsAt: new Date(Date.now() + 86400000).toISOString(), endsAt: new Date(Date.now() + 93600000).toISOString(), estimatedCost: 0, minParticipants: 4, maxParticipants: 8, reservedSeats: 2, initialFriendIds: [users[1].id, users[2].id] }
  assert.equal((await call(0, '/activities', 'POST', { ...draft, maxParticipants: 4 })).status, 409)
  let activity = (await call(0, '/activities', 'POST', draft)).body.activity
  const path = '/activities/' + activity.id
  assert.equal(activity.memberCount, 3)
  assert.equal(activity.readiness.confirmedParticipants, 1)
  assert.equal(activity.invitations, undefined)
  await t.test('self excluded and new public posts visible in other accounts and keyword search', async () => {
    assert.ok(!(await call(0, '/activities')).body.items.some(item => item.id === activity.id))
    assert.ok((await call(3, '/activities')).body.items.some(item => item.id === activity.id))
    assert.ok((await call(3, '/activities?q=Journey')).body.items.some(item => item.id === activity.id))
    assert.equal((await call(0, path + '/join-requests', 'POST', {})).status, 403)
  })
  let invitations
  await t.test('invitations notify recipient and confer no membership, chat or seat consumption before consent', async () => {
    invitations = (await call(1, '/activities/invitations')).body.items
    assert.equal(invitations.length, 1)
    assert.equal((await call(1, path + '/members')).status, 403)
    assert.equal((await call(1, '/conversations', 'POST', { type: 'group', activityId: activity.id })).status, 403)
    assert.ok((await call(1, '/community/notifications')).body.items.some(item => item.activityId === activity.id && item.type === 'activity-invitation'))
    assert.equal((await call(3, path + '/invitations/' + invitations[0].id, 'PATCH', { status: 'accepted' })).status, 404)
    assert.equal((await call(0, path + '/start', 'POST', {})).status, 409)
    assert.equal((await call(0, path + '/confirm-schedule', 'POST', { version: activity.version })).status, 409)
    assert.equal((await call(1, path + '/invitations/' + invitations[0].id, 'PATCH', { status: 'accepted' })).status, 200)
    assert.equal((await call(1, path + '/invitations/' + invitations[0].id, 'PATCH', { status: 'accepted' })).status, 200)
    assert.equal((await call(1, path + '/members')).body.total, 2)
    const second = (await call(2, '/activities/invitations')).body.items[0]
    assert.equal((await call(2, path + '/invitations/' + second.id, 'PATCH', { status: 'declined' })).status, 200)
    assert.equal((await call(2, path + '/members')).status, 403)
    assert.equal((await call(2, path + '/invitations/' + second.id, 'PATCH', { status: 'accepted' })).status, 409)
  })
  await t.test('host friends and companions cannot satisfy the external-member gate; minimum counts confirmed accounts', async () => {
    // Invite again, and convert a companion only after consent.
    assert.equal((await call(0, path + '/members/friends', 'POST', { friendIds: [users[2].id], useReservedSeats: true })).status, 200)
    const invitation = (await call(2, '/activities/invitations')).body.items[0]
    assert.equal((await call(2, path + '/invitations/' + invitation.id, 'PATCH', { status: 'accepted' })).status, 200)
    activity = (await call(0, path)).body.activity
    assert.equal(activity.reservedSeats, 1)
    assert.equal(activity.readiness.confirmedParticipants, 3)
    assert.equal(activity.readiness.externalParticipants, 0)
    assert.equal((await call(0, path + '/confirm-schedule', 'POST', { version: activity.version })).status, 409)
    const pending = (await call(3, path + '/join-requests', 'POST', {})).body.request
    assert.equal((await call(3, path + '/members')).status, 403)
    assert.equal((await call(0, path + '/start', 'POST', {})).status, 409)
    assert.equal((await call(0, path + '/join-requests/' + pending.id, 'PATCH', { status: 'approved' })).status, 200)
    activity = (await call(0, path)).body.activity
    assert.equal(activity.readiness.ready, true)
    assert.equal(activity.readiness.confirmedParticipants, 4)
    assert.equal(activity.readiness.externalParticipants, 1)
    assert.equal((await call(0, path + '/start', 'POST', {})).status, 409)
    assert.equal((await call(3, path + '/confirm-schedule', 'POST', { version: activity.version })).status, 403)
    assert.equal((await call(0, path + '/confirm-schedule', 'POST', { version: activity.version })).status, 200)
    assert.equal((await call(3, path + '/members/me', 'DELETE')).status, 204)
    assert.equal((await call(0, path + '/start', 'POST', {})).status, 409)
    const retry = (await call(3, path + '/join-requests', 'POST', {})).body.request
    await call(0, path + '/join-requests/' + retry.id, 'PATCH', { status: 'approved' })
    activity = (await call(0, path)).body.activity
    await call(0, path + '/confirm-schedule', 'POST', { version: activity.version })
    const starts = await Promise.all([call(0, path + '/start', 'POST', {}), call(0, path + '/start', 'POST', {})])
    assert.deepEqual(starts.map(item => item.status).sort(), [200, 409])
  })
  await t.test('attendance required to complete; only actual attendees rate once and can send friend requests', async () => {
    assert.equal((await call(3, '/community/ratings/' + activity.id)).status, 409)
    assert.equal((await call(0, path + '/complete', 'POST', {})).status, 409)
    for (const index of [0, 1, 2, 3]) assert.equal((await call(0, path + '/attendance/' + users[index].id, 'PATCH', { status: index === 2 ? 'absent' : 'present' })).status, 200)
    assert.equal((await call(0, path + '/complete', 'POST', {})).status, 200)
    assert.equal((await call(4, '/community/ratings/' + activity.id)).status, 403)
    assert.equal((await call(2, '/community/ratings/' + activity.id)).status, 403)
    const form = await call(3, '/community/ratings/' + activity.id)
    assert.deepEqual(form.body.members.map(item => item.id).sort(), [users[0].id, users[1].id].sort())
    const rating = { score: 5, comment: 'Good trip', members: [{ userId: users[0].id, score: 5 }] }
    assert.equal((await call(3, '/community/ratings/' + activity.id, 'POST', rating)).status, 200)
    assert.equal((await call(3, '/community/ratings/' + activity.id, 'POST', { ...rating, score: 1 })).status, 409)
    const request = (await call(3, '/friends/requests', 'POST', { userId: users[1].id })).body
    assert.ok(request)
    const incoming = (await call(1, '/friends/requests')).body.items.find(item => item.id === users[3].id)
    assert.ok(incoming)
    assert.equal((await call(1, '/friends/requests/' + incoming.friendshipId, 'PATCH', { status: 'accepted' })).status, 200)
    assert.ok((await call(3, '/friends')).body.items.some(item => item.id === users[1].id))
  })
  await t.test('simultaneous invitation acceptance never overbooks and closed registration stays out of search', async () => {
    const created = await call(0, '/activities', 'POST', { ...draft, title: 'Last seat race', reservedSeats: 0, minParticipants: 2, maxParticipants: 3 })
    assert.equal(created.status, 201)
    const race = await repository.get(created.body.activity.id)
    assert.equal(race.memberCount, 1)
    const external = (await call(3, '/activities/' + race.id + '/join-requests', 'POST', {})).body.request
    await call(0, '/activities/' + race.id + '/join-requests/' + external.id, 'PATCH', { status: 'approved' })
    const results = await Promise.all([1, 2].map(index => call(index, '/activities/' + race.id + '/invitations/' + race.invitations.find(item => item.userId === users[index].id).id, 'PATCH', { status: 'accepted' })))
    assert.deepEqual(results.map(item => item.status).sort(), [200, 409])
    const full = await repository.get(race.id)
    assert.equal(full.memberCount, 3)
    assert.equal(full.joinRequests.filter(item => item.status === 'approved').length, 2)
    assert.ok(!(await call(3, '/activities?q=Last')).body.items.some(item => item.id === race.id))
    await db.collection('activities').updateOne({ id: race.id }, { $set: { maxParticipants: 5, registrationDeadline: new Date(Date.now() - 1000) } })
    assert.ok(!(await call(3, '/activities?q=Last')).body.items.some(item => item.id === race.id))
  })
})
