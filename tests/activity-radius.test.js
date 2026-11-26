import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { createActivityRepository } from '../src/modules/activities/repository.js'
import { newToken, hashToken } from '../src/modules/auth/token.js'

test('radius and region use activity locations before pagination, independently of host location', async t => {
  const mongo = await MongoMemoryServer.create(); t.after(() => mongo.stop())
  const client = createClient(readConfig({ MONGODB_URI: mongo.getUri('radius_regions') })); await client.connect(); t.after(() => client.close())
  const db = client.db(); await initializeDatabase(db)
  const auth = createAuthRepository(db)
  const searcher = await auth.createUser({ name: 'Searcher', email: 'search-radius@example.com', passwordHash: 'unused' })
  await db.collection('users').updateOne({ id: searcher.id }, { $set: { email_verified: true, location: 'Hà Nội', coordinates: { type: 'Point', coordinates: [105.84, 21.03] } } })
  await db.collection('users').insertMany([
    { id: 'host-near', email: 'near@example.com', name: 'Near host', location: 'TP. Hồ Chí Minh', coordinates: { type: 'Point', coordinates: [106.7, 10.77] } },
    { id: 'host-far', email: 'far@example.com', name: 'Far host', location: 'Hà Nội', coordinates: { type: 'Point', coordinates: [105.84, 21.03] } },
  ])
  const token = newToken(); await auth.createSession({ userId: searcher.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 600000) })
  const point = latitude => ({ type: 'Point', coordinates: [106.7, latitude] })
  const base = { title: 'Event', description: 'Activity location differs from host location', hostId: 'host-far', hostName: 'Far host', province: 'TP. Hồ Chí Minh', district: 'Quận 1', ward: 'Bến Nghé', location: 'Quán cà phê', status: 'published', startsAt: new Date('2099-01-05T12:00:00Z'), estimatedCost: 0, category: 'Ăn uống', memberCount: 1, maxParticipants: 5 }
  const rows = [
    { id: 'inside', coordinates: point(10.7789) },
    { id: 'outside', hostId: 'host-near', coordinates: point(10.7791) },
    { id: 'far-same-province', hostId: 'host-near', coordinates: point(11.4) },
    { id: 'near-other-province', province: 'Đồng Nai', coordinates: point(10.771) },
    { id: 'conflicting-text', province: 'Hà Nội', location: 'TP.HCM', coordinates: point(10.771) },
    { id: 'legacy', province: undefined, location: 'Cà phê, TP.HCM', coordinates: point(10.772) },
    { id: 'other-district', district: 'Quận 3', ward: 'Võ Thị Sáu', coordinates: point(10.773) },
    { id: 'no-pin' },
  ].map(row => ({ ...base, ...row }))
  await db.collection('activities').insertMany(rows)
  const server = createApp(readConfig({}), { authRepository: auth, activityRepository: createActivityRepository(db) }).listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)))
  const get = async params => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/activities?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${token}` } })
    return { status: response.status, body: await response.json() }
  }
  const geo = { lat: '10.77', lng: '106.7', province: 'TP. Hồ Chí Minh', distanceKm: '1' }
  await t.test('1 km boundary excludes a 1.01 km activity even when its host is nearby', async () => {
    const { status, body } = await get(geo)
    assert.equal(status, 200)
    assert.deepEqual(body.items.map(row => row.id).sort(), ['inside', 'legacy', 'other-district'])
    assert.ok(body.items.every(row => row.distanceKm >= 0 && row.distanceKm <= 1))
    assert.ok(body.items.find(row => row.id === 'inside').distanceKm > 0.98)
    assert.equal(body.items.some(row => row.id === 'outside'), false)
  })
  await t.test('50 km+ removes distance cap while retaining region and unpinned events', async () => {
    const { body } = await get({ province: 'TP. Hồ Chí Minh', sort: 'recommended', limit: '2' })
    assert.equal(body.total, 6); assert.equal(body.items.length, 2); assert.equal(body.hasMore, true)
    const all = []
    for (let page = 1; page <= 3; page++) all.push(...(await get({ province: 'TP. Hồ Chí Minh', page: String(page), limit: '2' })).body.items)
    assert.equal(new Set(all.map(row => row.id)).size, 6)
    assert.ok(all.some(row => row.id === 'far-same-province'))
    assert.ok(all.some(row => row.id === 'no-pin'))
    assert.equal(all.some(row => ['near-other-province', 'conflicting-text'].includes(row.id)), false)
    assert.equal((await get({ ...geo, distanceKm: '49' })).body.items.some(row => row.id === 'far-same-province'), false)
  })
  await t.test('region filters combine before counts/paging and structured fields override display text', async () => {
    const { body } = await get({ ...geo, district: 'Quận 1', ward: 'Bến Nghé', limit: '1' })
    assert.equal(body.total, 2); assert.equal(body.hasMore, true)
    const second = (await get({ ...geo, district: 'Quận 1', ward: 'Bến Nghé', limit: '1', page: '2' })).body
    assert.equal(second.items.length, 1); assert.notEqual(body.items[0].id, second.items[0].id); assert.equal(second.hasMore, false)
    assert.equal((await get({ ...geo, province: 'TP.HCM' })).body.total, 3)
    assert.equal((await get({ province: 'Hà Nội' })).body.total, 1)
    assert.equal((await get({ province: '.*' })).body.total, 0, 'literal region search must not execute regex input')
    assert.equal((await get({ province: 'x'.repeat(101) })).status, 400)
  })
})
