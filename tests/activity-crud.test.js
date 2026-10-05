import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { MongoMemoryServer } from 'mongodb-memory-server'
import sharp from 'sharp'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { createActivityRepository } from '../src/modules/activities/repository.js'
import { hashToken, newToken } from '../src/modules/auth/token.js'

test('activity CRUD lifecycle and ownership', async t => {
  const mongo = await MongoMemoryServer.create(); t.after(() => mongo.stop())
  const connection = createClient(readConfig({ MONGODB_URI: mongo.getUri('activity_crud') }))
  await connection.connect(); t.after(() => connection.close())
  const db = connection.db(); await initializeDatabase(db)
  const authRepository = createAuthRepository(db), repository = createActivityRepository(db)
  const users = [], tokens = []
  for (let i = 0; i < 2; i++) {
    const user = await authRepository.createUser({ name: `User ${i}`, email: `crud${i}@example.com`, passwordHash: 'unused' })
    await db.collection('users').updateOne({ id: user.id }, { $set: { email_verified: true } })
    users.push(user); tokens.push(newToken())
    await authRepository.createSession({ userId: user.id, tokenHash: hashToken(tokens[i]), expiresAt: new Date(Date.now() + 120000) })
  }
  let uploads = 0
  const removed = []
  const coverStorage = { async upload() { return { publicId: `cover-${++uploads}`, url: `https://res.cloudinary.com/test/image/upload/${uploads}.webp` } }, async remove(id) { removed.push(id) } }
  const server = createApp(readConfig({}), { authRepository, activityRepository: repository, coverStorage }).listen(0, '127.0.0.1')
  await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api/activities`
  const req = async (path = '', method = 'GET', body, token = tokens[0]) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, body: response.status === 204 ? null : await response.json() }
  }
  const body = { title: 'Coffee meetup', description: 'Chat with new friends', category: 'Ăn uống', location: 'Saigon',
    startsAt: '2099-01-05T12:00:00Z', endsAt: '2099-01-05T14:00:00Z', estimatedCost: 0, maxParticipants: 6,
    coordinates: { type: 'Point', coordinates: [106.7, 10.77] }, requirements: ['Be on time'] }
  let id
  await t.test('validates input and derives host, state and membership on the server', async () => {
    assert.equal((await req('', 'POST', body, '')).status, 401)
    for (const change of [{ hostId: users[1].id }, { memberCount: 100 }, { status: 'published' }, { estimatedCost: '0' },
      { startsAt: '2000-01-01T00:00:00Z' }, { endsAt: '2099-01-05T11:00:00Z' }, { title: '' }, { startsAt: '2099-02-30T00:00:00Z' },
      { coordinates: { type: 'Point', coordinates: [181, 0] } }]) assert.equal((await req('', 'POST', { ...body, ...change })).status, 400)
    const created = await req('', 'POST', body)
    assert.equal(created.status, 201)
    const row = created.body.activity; id = row.id
    assert.equal(row.hostId, users[0].id); assert.equal(row.memberCount, 1); assert.equal(row.status, 'published')
    assert.equal(row._id, undefined); assert.equal(row.version, 1)
  })
  await t.test('detail, owner list and discovery reflect persistent data', async () => {
    assert.equal((await req(`/${id}`)).body.activity.title, body.title)
    assert.equal((await req('/mine')).body.items[0].id, id)
    assert.equal((await req('/mine', 'GET', undefined, tokens[1])).body.total, 0)
    assert.equal((await req('')).body.total, 0)
    assert.equal((await req('', 'GET', undefined, tokens[1])).body.items[0].id, id)
    assert.equal((await req('/mine?hostId=x')).status, 400)
  })
  await t.test('only owner edits; validation, capacity and stale writes are enforced', async () => {
    assert.equal((await req(`/${id}`, 'PATCH', { title: 'Hacked title' }, tokens[1])).status, 403)
    assert.equal((await req(`/${id}`, 'DELETE', undefined, tokens[1])).status, 403)
    assert.equal((await req(`/${id}`, 'PATCH', { title: 'Updated meetup' })).status, 200)
    assert.equal((await req(`/${id}`)).body.activity.description, body.description)
    await db.collection('activities').updateOne({ id }, { $set: { memberCount: 4 } })
    assert.equal((await req(`/${id}`, 'PATCH', { maxParticipants: 3 })).status, 409)
    const before = await repository.get(id)
    assert.ok(await repository.update(before, { title: 'First writer' }))
    assert.equal(await repository.update(before, { title: 'Stale writer' }), null)
  })
  await t.test('cover replacement cleans previous image and invalid uploads preserve it', async () => {
    const image = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#228833' } }).png().toBuffer()
    const coverBase64 = image.toString('base64')
    const first = await req(`/${id}`, 'PATCH', { coverBase64 })
    assert.equal(first.status, 200); assert.equal(first.body.activity.imagePublicId, undefined)
    assert.equal((await req(`/${id}`, 'PATCH', { coverBase64 })).status, 200)
    assert.ok(removed.includes('cover-1'))
    assert.equal((await req(`/${id}`, 'PATCH', { coverBase64: 'AAAA' })).status, 400)
    assert.equal((await repository.get(id)).imagePublicId, 'cover-2')
    const originalCreate = repository.create
    repository.create = async () => { throw new Error('test failure') }
    try { assert.equal((await req('', 'POST', { ...body, coverBase64 })).status, 500) }
    finally { repository.create = originalCreate }
    assert.ok(removed.includes('cover-3'))
  })
  await t.test('started activities cannot be edited; delete hides detail, owner list and discovery', async () => {
    await db.collection('activities').updateOne({ id }, { $set: { startsAt: new Date(0) } })
    assert.equal((await req(`/${id}`, 'PATCH', { title: 'Too late' })).status, 409)
    assert.equal((await req(`/${id}`, 'DELETE')).status, 204)
    assert.equal((await req(`/${id}`)).status, 404)
    assert.equal((await req('/mine')).body.total, 0)
    assert.equal((await req('', 'GET', undefined, tokens[1])).body.total, 0)
    assert.ok(removed.includes('cover-2'))
    assert.equal((await db.collection('activities').findOne({ id })).status, 'deleted')
  })
})
