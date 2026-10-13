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

test('activity lifecycle, attendance and atomic audit log', async t => {
  const mongo = await MongoMemoryServer.create(); t.after(() => mongo.stop())
  const client = createClient(readConfig({ MONGODB_URI: mongo.getUri('lifecycle') }))
  await client.connect(); t.after(() => client.close())
  const db = client.db(); await initializeDatabase(db)
  const authRepository = createAuthRepository(db), repository = createActivityRepository(db)
  const users = [], tokens = []
  for (let i = 0; i < 3; i++) {
    const user = await authRepository.createUser({ name: `User ${i}`, email: `life${i}@example.com`, passwordHash: 'unused' })
    await db.collection('users').updateOne({ id: user.id }, { $set: { email_verified: true } })
    users.push(user); tokens.push(newToken())
    await authRepository.createSession({ userId: user.id, tokenHash: hashToken(tokens[i]), expiresAt: new Date(Date.now() + 120000) })
  }
  const activity = await repository.create({ title: 'Lifecycle', startsAt: new Date('2099-01-01'), maxParticipants: 3 }, users[0])
  const join = await repository.submitJoinRequest(activity.id, users[1])
  await repository.changeJoinRequest(activity.id, { hostId: users[0].id, requestId: join.id, status: 'approved' })
  await repository.submitJoinRequest(activity.id, users[2])
  const server = createApp(readConfig({}), { authRepository, activityRepository: repository }).listen(0, '127.0.0.1')
  await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)))
  const req = async (user, path, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/activities/${activity.id}${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...(user >= 0 ? { Authorization: `Bearer ${tokens[user]}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, body: response.status === 204 ? null : await response.json() }
  }
  assert.equal((await req(-1, '/start', 'POST')).status, 401)
  assert.equal((await req(1, '/start', 'POST')).status, 403)
  assert.equal((await req(0, '/complete', 'POST')).status, 409)
  assert.equal((await req(0, '/start', 'POST', { status: 'completed' })).status, 400)
  assert.equal((await req(0, '/updates', 'POST', { text: 'too early' })).status, 409)
  const starts = await Promise.all([req(0, '/start', 'POST'), req(0, '/start', 'POST')])
  assert.deepEqual(starts.map(r => r.status).sort(), [200, 409])
  const row = starts.find(r => r.status === 200).body.activity
  assert.equal(row.status, 'in-progress'); assert.ok(row.startedAt)
  assert.equal(row.attendance, undefined); assert.equal(row.updates, undefined)
  assert.equal((await req(1, '')).status, 200)
  assert.equal((await req(2, '')).status, 404)
  assert.equal((await req(2, '/attendance')).status, 403)
  assert.equal((await req(0, '/attendance?limit=0')).status, 400)
  assert.equal((await req(1, '/attendance?limit=1')).body.hasMore, true)
  assert.equal((await req(1, '/attendance')).body.total, 2)
  assert.equal((await req(0, `/attendance/${users[2].id}`, 'PATCH', { status: 'present' })).status, 404)
  assert.equal((await req(1, `/attendance/${users[1].id}`, 'PATCH', { status: 'present' })).status, 403)
  assert.equal((await req(0, `/attendance/${users[1].id}`, 'PATCH', { status: 'bad' })).status, 400)
  const mark = await req(0, `/attendance/${users[1].id}`, 'PATCH', { status: 'present' })
  assert.equal(mark.status, 200); assert.equal(mark.body.attendance.updatedBy, users[0].id)
  await req(0, `/attendance/${users[1].id}`, 'PATCH', { status: 'present' })
  assert.equal((await req(0, '/updates')).body.total, 2)
  assert.equal((await req(0, '/updates', 'POST', { text: 'Meet at the entrance' })).status, 201)
  assert.equal((await req(1, '/updates', 'POST', { text: 'not host' })).status, 403)
  assert.equal((await req(0, '', 'PATCH', { title: 'Cannot edit' })).status, 409)
  assert.equal((await req(1, '/members/me', 'DELETE')).status, 409)
  const before = await repository.get(activity.id)
  const complete = await req(0, '/complete', 'POST')
  assert.equal(complete.status, 200); assert.ok(complete.body.activity.completedAt)
  assert.equal(await repository.lifecycle(before, users[0].id, {}, { id: 'stale', createdAt: new Date(), type: 'note' }), null)
  assert.equal((await req(0, '/complete', 'POST')).status, 409)
  assert.equal((await req(0, `/attendance/${users[1].id}`, 'PATCH', { status: 'absent' })).status, 409)
  assert.equal((await req(0, '/updates', 'POST', { text: 'too late' })).status, 409)
  const log = (await req(1, '/updates')).body
  assert.deepEqual(log.items.map(e => e.type), ['completed', 'note', 'attendance-changed', 'started'])
  assert.equal(log.items[2].previousStatus, 'unmarked')
  assert.equal((await repository.participating(users[1].id, { page: 1, limit: 20 })).items[0].status, 'completed')
  assert.equal((await createChatRepository(db).create(users[1].id, { type: 'group', activityId: activity.id })).type, 'group')
  await repository.remove(await repository.get(activity.id))
  assert.equal((await req(0, '/updates')).status, 404)
})
