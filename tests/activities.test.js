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

test('activity discovery queries MongoDB with combined filters and stable paging', async t => {
  const mongo = await MongoMemoryServer.create()
  t.after(() => mongo.stop())
  const connection = createClient(readConfig({ MONGODB_URI: mongo.getUri('discovery_test') }))
  await connection.connect(); t.after(() => connection.close())
  const db = connection.db(); await initializeDatabase(db)
  const authRepository = createAuthRepository(db)
  const user = await authRepository.createUser({ name: 'Searcher', email: 'search@example.com', passwordHash: 'unused' })
  await db.collection('users').updateOne({ id: user.id }, { $set: { email_verified: true } })
  const token = newToken()
  await authRepository.createSession({ userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 60000) })
  // 2099 fixture stays in the future; UTC 12:00 = 19:00 in Vietnam.
  const startsAt = new Date('2099-01-05T12:00:00Z')
  const template = { title: 'Coffee friends', description: 'Meet for coffee', location: 'Saigon', category: 'Ăn uống',
    status: 'published', startsAt, hostId: 'someone-else', hostName: 'Host', memberCount: 1, maxParticipants: 5,
    estimatedCost: 50000, tags: ['Coffee'], coordinates: { type: 'Point', coordinates: [106.7, 10.77] }, internalNote: 'private' }
  const rows = [
    { id: 'a' }, { id: 'b', title: 'Badminton', description: 'Sport', tags: ['Sport'], category: 'Thể thao', estimatedCost: 150000 },
    { id: 'c', location: 'Hanoi', coordinates: { type: 'Point', coordinates: [105.84, 21.03] }, estimatedCost: 0 },
    { id: 'own', hostId: user.id }, { id: 'full', memberCount: 5 }, { id: 'draft', status: 'draft' },
    { id: 'cancelled', status: 'cancelled' }, { id: 'past', startsAt: new Date(0) },
  ].map(row => ({ ...template, ...row }))
  await db.collection('activities').insertMany(rows)
  const server = createApp(readConfig({}), { authRepository, activityRepository: createActivityRepository(db) }).listen(0, '127.0.0.1')
  await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/api/activities`
  const get = async (params = {}, auth = token) => {
    const response = await fetch(`${url}?${new URLSearchParams(params)}`, { headers: auth ? { Authorization: `Bearer ${auth}` } : {} })
    return { status: response.status, body: await response.json() }
  }
  await t.test('authenticated, future, published, not full, not own', async () => {
    assert.equal((await get({}, '')).status, 401)
    const { body } = await get()
    assert.deepEqual(body.items.map(item => item.id), ['a', 'b', 'c'])
    assert.equal(body.total, 3)
    assert.equal(body.items[0].distanceKm, null)
    assert.equal(body.items[0].internalNote, undefined)
    const first = await get({ limit: '2' }), second = await get({ limit: '2', page: '2' })
    assert.deepEqual(first.body.items.map(item => item.id), ['a', 'b'])
    assert.deepEqual(second.body.items.map(item => item.id), ['c'])
    assert.equal(first.body.hasMore, true); assert.equal(second.body.hasMore, false)
  })
  await t.test('literal keyword, category and VND budget combined', async () => {
    const result = await get({ q: 'COFFEE', categories: 'Ăn uống', minCost: '1', maxCost: '99999' })
    assert.deepEqual(result.body.items.map(item => item.id), ['a'])
    assert.equal((await get({ q: '.*' })).body.total, 0)
    assert.deepEqual((await get({ maxCost: '0' })).body.items.map(item => item.id), ['c'])
    assert.equal((await get({ q: 'Hanoi' })).body.total, 1)
  })
  await t.test('real distance and local weekday/hour filters', async () => {
    const localWeekday = startsAt.getUTCDay() || 7
    const result = await get({ lat: '10.77', lng: '106.7', distanceKm: '10', days: String(localWeekday), fromHour: '18', toHour: '24' })
    assert.equal(result.status, 200)
    assert.deepEqual(result.body.items.map(item => item.id), ['a', 'b'])
    assert.ok(result.body.items[0].distanceKm < 0.01)
    assert.equal((await get({ fromHour: '6', toHour: '12' })).body.total, 0)
    assert.equal((await get({ days: String(localWeekday === 7 ? 1 : localWeekday + 1) })).body.total, 0)
  })
  await t.test('invalid/injected queries fail and empty pages are well-formed', async () => {
    for (const params of [{ lat: '91', lng: '0' }, { lat: '1' }, { distanceKm: '10' }, { limit: '1000' },
      { page: '0' }, { minCost: '100', maxCost: '10' }, { days: '0' }, { fromHour: '20', toHour: '10' },
      { categories: 'unknown' }, { q: 'x'.repeat(101) }, { 'q[$ne]': 'x' }, { lng: 'NaN' }]) {
      assert.equal((await get(params)).status, 400)
    }
    const result = await get({ page: '50' })
    assert.equal(result.status, 200); assert.deepEqual(result.body.items, []); assert.equal(result.body.hasMore, false)
  })
})
