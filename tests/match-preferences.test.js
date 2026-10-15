import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import sharp from 'sharp'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { createActivityRepository } from '../src/modules/activities/repository.js'
import { hashToken, newToken } from '../src/modules/auth/token.js'

test('Match preferences, discovery ranking, favorites and profile cover persist independently per account', async t => {
  const mongo = await MongoMemoryServer.create(); t.after(() => mongo.stop())
  const client = createClient(readConfig({ MONGODB_URI: mongo.getUri('match_p1') })); await client.connect(); t.after(() => client.close())
  const db = client.db(); await initializeDatabase(db)
  const auth = createAuthRepository(db), activities = createActivityRepository(db)
  const users = [], tokens = []
  for (let i = 0; i < 3; i++) {
    const user = await auth.createUser({ name: `Match User ${i}`, email: `match${i}@example.com`, passwordHash: 'hidden' })
    await db.collection('users').updateOne({ id: user.id }, { $set: { email_verified: true, interests: ['Cà phê'] } })
    const token = newToken(); await auth.createSession({ userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 600000) })
    users.push(user); tokens.push(token)
  }
  const images = new Map(), removed = []; let sequence = 0
  const storage = { async upload(bytes) { const publicId = `cover-${++sequence}`; images.set(publicId, bytes); return { publicId, url: `https://res.cloudinary.com/test/${publicId}` } }, async remove(id) { removed.push(id); images.delete(id) } }
  const server = createApp(readConfig({}), { authRepository: auth, activityRepository: activities, avatarStorage: storage }).listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = async (path, method = 'GET', body, user = 0) => {
    const res = await fetch(`${base}/api${path}`, { method, headers: { Authorization: `Bearer ${tokens[user]}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: res.status, body: res.status === 204 ? null : await res.json() }
  }
  const draft = { title: 'Thể thao sớm', category: 'Thể thao', description: 'Giao lưu cuối tuần', location: 'TP.HCM', startsAt: new Date('2099-01-01T02:00:00Z'), endsAt: new Date('2099-01-01T04:00:00Z'), estimatedCost: 0, maxParticipants: 6, coordinates: { type: 'Point', coordinates: [106.7, 10.77] } }
  const personal = await activities.create(draft, users[1])
  const business = await activities.create({ ...draft, organizerType: 'business', title: 'Cà phê cùng bạn', category: 'Ăn uống', startsAt: new Date('2099-02-01T02:00:00Z') }, users[1])
  const far = await activities.create({ ...draft, coordinates: { type: 'Point', coordinates: [105.85, 21.02] } }, users[1])
  await t.test('organizer type defaults, validates and filters legacy records', async () => {
    assert.equal((await request('/activities?organizerType=business')).body.items[0].id, business.id)
    await db.collection('activities').updateOne({ id: personal.id }, { $unset: { organizerType: '' } })
    assert.deepEqual((await request('/activities?organizerType=personal')).body.items.map(item => item.id).sort(), [personal.id, far.id].sort())
    assert.equal((await request('/activities?organizerType=invalid')).status, 400)
    const created = await request('/activities', 'POST', { ...draft, startsAt: draft.startsAt.toISOString(), endsAt: draft.endsAt.toISOString(), organizerType: 'business' })
    assert.equal(created.status, 403)
  })
  await t.test('radius uses actual coordinates; recommendation scores precede pagination', async () => {
    const near = await request('/activities?lat=10.77&lng=106.7&distanceKm=5')
    assert.equal(near.status, 200); assert.equal(near.body.total, 2); assert.ok(near.body.items.every(item => item.distanceKm < 0.01))
    const ranked = await request('/activities?sort=recommended&limit=1')
    assert.equal(ranked.status, 200); assert.equal(ranked.body.items[0].id, business.id)
    assert.equal((await request('/activities?sort=soonest&limit=1')).body.items[0].startsAt, draft.startsAt.toISOString())
    await request('/me/match-feedback', 'POST', { activityId: business.id, outcome: 'dislike' })
    assert.notEqual((await request('/activities?sort=recommended&limit=1')).body.items[0].id, business.id)
    assert.equal((await request('/me/match-feedback', 'POST', { activityId: business.id, outcome: 'invented' })).status, 400)
    assert.equal((await request('/activities?distanceKm=5')).status, 400)
    assert.equal((await request('/activities?sort=nearest')).status, 400)
  })
  await t.test('saved filters are isolated and reject persisted GPS and unsupported deposit filters', async () => {
    const filters = { organizerType: 'business', sort: 'nearest', distance: 20, radiusEnabled: true, categories: ['Ăn uống'], preferences: { genders: [], languages: [], religions: [], alcohol: 'any', dressCode: '' } }
    assert.equal((await request('/me/match-preferences', 'PUT', filters)).status, 200)
    assert.deepEqual((await request('/me/match-preferences')).body.filters, filters)
    assert.equal((await request('/me/match-preferences', 'GET', undefined, 2)).body.filters, null)
    for (const invalid of [{ coordinates: { latitude: 10, longitude: 106 } }, { depositAmount: 1 }, { distance: 501 }, { distance: 0 }, { minimumCapacity: 1 }, { dateFrom: '31/02/2027' }, { categories: ['invalid'] }, { fromTime: '25:00' }]) assert.equal((await request('/me/match-preferences', 'PUT', invalid)).status, 400)
  })
  await t.test('favorite writes are idempotent and survive a fresh read without exposing another account', async () => {
    for (let i = 0; i < 2; i++) assert.equal((await request(`/me/favorites/${business.id}`, 'PUT')).status, 204)
    assert.deepEqual((await request('/me/match-preferences')).body.favoriteIds, [business.id])
    assert.equal((await request('/me/favorites')).body.items[0].id, business.id)
    assert.equal((await request('/me/favorites', 'GET', undefined, 2)).body.total, 0)
    assert.equal((await request('/me/favorites/missing', 'PUT')).status, 404)
    await db.collection('activities').updateOne({ id: business.id }, { $set: { status: 'deleted' } })
    assert.equal((await request('/me/favorites')).body.total, 0)
    assert.equal((await request(`/me/favorites/${business.id}`, 'DELETE')).status, 204)
    assert.deepEqual((await request('/me/match-preferences')).body.favoriteIds, [])
  })
  await t.test('cover validates images, persists separately from avatar, cleans replaced assets and removes safely', async () => {
    const base64 = (await sharp({ create: { width: 160, height: 60, channels: 3, background: '#dcd8ff' } }).png().toBuffer()).toString('base64')
    const uploaded = await request('/profile/me/cover', 'PUT', { base64 })
    assert.equal(uploaded.status, 200); assert.ok(uploaded.body.profile.coverUrl); assert.equal(uploaded.body.profile.avatarUrl, null)
    assert.equal((await request(`/profile/${users[0].id}`, 'GET', undefined, 2)).body.profile.coverUrl, uploaded.body.profile.coverUrl)
    assert.equal((await request('/profile/me/cover', 'PUT', { base64: 'AAAA' })).status, 400)
    assert.equal((await request('/profile/me')).body.profile.coverUrl, uploaded.body.profile.coverUrl)
    await request('/profile/me/cover', 'PUT', { base64 }); assert.equal(removed.length, 1)
    assert.equal((await request('/profile/me', 'GET', undefined, 2)).body.profile.coverUrl, null)
    assert.equal((await request('/profile/me/cover', 'DELETE')).body.profile.coverUrl, null); assert.equal(images.size, 0)
  })
  await t.test('map assets are self hosted under CSP and Google setup remains optional', async () => {
    const map = await fetch(`${base}/map.html`); assert.equal(map.status, 200); assert.match(await map.text(), /map-ui\/map.js/)
    assert.match(map.headers.get('content-security-policy'), /tile.openstreetmap.org/)
    assert.match(map.headers.get('content-security-policy'), /frame-ancestors 'self' http:\/\/localhost:8081/)
    assert.equal(map.headers.get('x-frame-options'), null)
    assert.equal((await fetch(`${base}/map-assets/leaflet.js`)).status, 200)
    assert.equal((await request('/auth/google/config')).body.clientId, null)
  })
})
