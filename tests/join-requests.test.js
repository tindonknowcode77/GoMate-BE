import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { createActivityRepository } from '../src/modules/activities/repository.js'
import { hashToken, newToken } from '../src/modules/auth/token.js'

test('join requests: authorization, lifecycle and concurrent capacity enforcement', async t => {
  const mongo = await MongoMemoryServer.create(); t.after(() => mongo.stop())
  const client = createClient(readConfig({ MONGODB_URI: mongo.getUri('join_requests') }))
  await client.connect(); t.after(() => client.close())
  const db = client.db(); await initializeDatabase(db)
  const authRepository = createAuthRepository(db), repository = createActivityRepository(db)
  const users = [], tokens = []
  for (let i = 0; i < 4; i++) {
    const user = await authRepository.createUser({ name: `User ${i}`, email: `join${i}@example.com`, passwordHash: 'unused' })
    await db.collection('users').updateOne({ id: user.id }, { $set: { email_verified: true } })
    users.push(user); tokens.push(newToken())
    await authRepository.createSession({ userId: user.id, tokenHash: hashToken(tokens[i]), expiresAt: new Date(Date.now() + 120000) })
  }
  const server = createApp(readConfig({}), { authRepository, activityRepository: repository }).listen(0, '127.0.0.1')
  await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)))
  const activity = await repository.create({ title: 'Meetup', startsAt: new Date('2099-01-01'), maxParticipants: 2 }, users[0])
  const base = `http://127.0.0.1:${server.address().port}/api/activities/${activity.id}`
  const req = async (user, path = '', method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(user >= 0 ? { Authorization: `Bearer ${tokens[user]}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, body: response.status === 204 ? null : await response.json() }
  }
  const path = '/join-requests'
  const mine = async (user, endpoint) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/me/${endpoint}`, {
      headers: user >= 0 ? { Authorization: `Bearer ${tokens[user]}` } : {},
    })
    return { status: response.status, body: await response.json() }
  }
  for (const endpoint of ['activities', 'join-requests']) {
    assert.equal((await mine(-1, endpoint)).status, 401)
    assert.equal((await mine(1, endpoint)).body.total, 0)
    for (const query of ['page=0', 'limit=51', 'userId=other', 'page=1&page=2']) {
      assert.equal((await mine(1, `${endpoint}?${query}`)).status, 400)
    }
  }
  assert.equal((await mine(1, 'activities?status=pending')).status, 400)
  assert.equal((await mine(1, 'join-requests?status=invalid')).status, 400)
  assert.equal((await req(-1, path, 'POST')).status, 401)
  assert.equal((await req(0, path, 'POST')).status, 403)
  assert.equal((await req(1, path, 'POST', { userId: users[2].id })).status, 400)
  const duplicate = await Promise.all([req(1, path, 'POST'), req(1, path, 'POST')])
  assert.deepEqual(duplicate.map(r => r.status).sort(), [201, 409])
  const first = duplicate.find(r => r.status === 201).body.request
  assert.equal(first.userId, users[1].id)
  const ownPending = (await mine(1, 'join-requests?status=pending')).body
  assert.equal(ownPending.items[0].id, first.id)
  assert.equal(ownPending.items[0].activityId, activity.id)
  assert.equal(ownPending.items[0].activity.joinRequests, undefined)
  assert.equal((await mine(1, 'activities')).body.total, 0)
  assert.equal((await mine(2, 'join-requests')).body.total, 0)
  assert.equal((await req(1, path)).status, 403)
  assert.equal((await req(1, `${path}/${first.id}`, 'PATCH', { status: 'approved' })).status, 403)
  assert.equal((await req(2, `${path}/me`, 'DELETE')).status, 404)
  assert.equal((await req(1, `${path}/me`, 'DELETE')).status, 204)
  assert.equal((await mine(1, 'join-requests?status=cancelled')).body.total, 1)
  assert.equal((await mine(1, 'join-requests?status=pending')).body.total, 0)
  assert.equal((await req(1, `${path}/me`, 'DELETE')).status, 409)
  const second = (await req(1, path, 'POST')).body.request
  assert.notEqual(second.id, first.id)
  assert.equal((await req(0, `${path}/${first.id}`, 'PATCH', { status: 'approved' })).status, 404)
  assert.equal((await req(0, `${path}/${second.id}`, 'PATCH', { status: 'pending' })).status, 400)
  assert.equal((await req(0, `${path}/${second.id}`, 'PATCH', { status: 'rejected' })).status, 200)
  assert.equal((await repository.get(activity.id)).memberCount, 1)
  assert.equal((await mine(1, 'join-requests?status=rejected')).body.total, 1)
  const a = (await req(1, path, 'POST')).body.request
  const b = (await req(2, path, 'POST')).body.request
  const listing = await req(0, `${path}?status=pending&limit=1`)
  assert.equal(listing.body.total, 2); assert.equal(listing.body.hasMore, true)
  assert.equal((await req(0, `${path}?status=invalid`)).status, 400)
  assert.equal((await req(0, `${path}?page=0`)).status, 400)
  assert.equal((await req(0, `${path}?userId=x`)).status, 400)
  assert.equal((await req(1)).body.activity.joinRequests, undefined)
  const outcomes = await Promise.all([a, b].map(r => req(0, `${path}/${r.id}`, 'PATCH', { status: 'approved' })))
  assert.deepEqual(outcomes.map(r => r.status).sort(), [200, 409])
  const approved = outcomes.find(r => r.status === 200).body.request
  assert.equal((await req(0, `${path}/${approved.id}`, 'PATCH', { status: 'approved' })).status, 409)
  assert.equal((await req(3, path, 'POST')).status, 409)
  const approvedUser = users.findIndex(u => u.id === approved.userId)
  assert.equal((await req(approvedUser, `${path}/me`, 'DELETE')).status, 409)
  const stored = await repository.get(activity.id)
  assert.equal(stored.memberCount, 2)
  assert.equal(stored.joinRequests.filter(r => r.status === 'approved').length, 1)
  assert.equal(stored.joinRequests.length, 2)
  const pending = stored.joinRequests.find(r => r.status === 'pending')
  assert.equal((await req(-1, '/members')).status, 401)
  assert.equal((await req(3, '/members')).status, 403)
  assert.equal((await req(0, '/members?limit=0')).status, 400)
  const members = (await req(approvedUser, '/members')).body
  assert.equal(members.total, 2)
  assert.deepEqual(members.items[0], { userId: users[0].id, name: users[0].name, role: 'host' })
  assert.equal(members.items[1].status, undefined)
  assert.equal((await req(0, '/members/me', 'DELETE')).status, 403)
  assert.equal((await req(0, `/members/${users[0].id}`, 'DELETE')).status, 403)
  assert.equal((await req(approvedUser, `/members/${users[0].id}`, 'DELETE')).status, 403)
  const joined = (await mine(approvedUser, 'activities')).body
  assert.equal(joined.total, 1); assert.equal(joined.items[0].id, activity.id)
  assert.equal(joined.items[0].joinRequests, undefined)
  assert.equal(joined.items[0].ownRequest, undefined)
  assert.equal((await mine(0, 'activities')).body.total, 0)
  const pendingUser = users.findIndex(u => u.id === pending.userId)
  assert.equal((await mine(pendingUser, 'activities')).body.total, 0)
  assert.equal((await mine(pendingUser, 'join-requests?status=approved')).body.total, 0)
  // Another activity verifies paging, stable ordering, total and private fields.
  const other = await repository.create({ title: 'Second', startsAt: new Date('2099-02-01'), maxParticipants: 3 }, users[0])
  const otherRequest = await repository.submitJoinRequest(other.id, users[approvedUser])
  await repository.changeJoinRequest(other.id, { hostId: users[0].id, requestId: otherRequest.id, status: 'approved' })
  const pageOne = (await mine(approvedUser, 'activities?limit=1')).body
  const pageTwo = (await mine(approvedUser, 'activities?limit=1&page=2')).body
  assert.equal(pageOne.total, 2); assert.equal(pageOne.hasMore, true)
  assert.equal(pageTwo.hasMore, false); assert.equal(pageTwo.items[0].id, other.id)
  assert.equal((await mine(approvedUser, 'activities?page=3&limit=1')).body.items.length, 0)
  const requestPage = (await mine(approvedUser, 'join-requests?limit=1')).body
  assert.equal(requestPage.total, 2); assert.equal(requestPage.hasMore, true)
  assert.equal(requestPage.items[0].id, otherRequest.id)
  assert.equal(requestPage.items[0].activity._id, undefined)
  await repository.remove(await repository.get(other.id))
  const removals = await Promise.all([
    req(approvedUser, '/members/me', 'DELETE'),
    req(0, `/members/${users[approvedUser].id}`, 'DELETE'),
  ])
  assert.equal(removals.filter(r => r.status === 204).length, 1)
  assert.ok(removals.some(r => [404, 409].includes(r.status)))
  assert.equal((await repository.get(activity.id)).memberCount, 1)
  assert.equal((await mine(approvedUser, 'activities')).body.total, 0)
  assert.equal((await req(approvedUser, '/members')).status, 403)
  let rejoin = (await req(approvedUser, path, 'POST')).body.request
  assert.equal((await req(0, `${path}/${rejoin.id}`, 'PATCH', { status: 'approved' })).status, 200)
  assert.equal((await req(0, `/members/${users[approvedUser].id}`, 'DELETE')).status, 204)
  assert.equal((await mine(approvedUser, 'join-requests?status=removed')).body.total, 1)
  rejoin = (await req(approvedUser, path, 'POST')).body.request
  await req(0, `${path}/${rejoin.id}`, 'PATCH', { status: 'approved' })
  assert.equal((await req(approvedUser, '/members/me', 'DELETE')).status, 204)
  assert.equal((await mine(approvedUser, 'join-requests?status=left')).body.total, 1)
  rejoin = (await req(approvedUser, path, 'POST')).body.request
  await req(0, `${path}/${rejoin.id}`, 'PATCH', { status: 'approved' })
  await db.collection('activities').updateOne({ id: activity.id }, { $set: { startsAt: new Date(0) } })
  assert.equal((await req(approvedUser, '/members/me', 'DELETE')).status, 409)
  assert.equal((await req(0, `/members/${users[approvedUser].id}`, 'DELETE')).status, 409)
  assert.equal((await mine(approvedUser, 'activities')).body.total, 1)
  assert.equal((await req(0, `${path}/${pending.id}`, 'PATCH', { status: 'rejected' })).status, 409)
  assert.equal((await req(3, path, 'POST')).status, 409)
  await repository.remove(await repository.get(activity.id))
  assert.equal((await req(0, path)).status, 404)
  assert.equal((await req(3, path, 'POST')).status, 404)
  assert.equal((await req(0, '/members')).status, 404)
  assert.equal((await mine(approvedUser, 'activities')).body.total, 0)
  assert.equal((await mine(approvedUser, 'join-requests')).body.total, 0)
})
