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

test('activity galleries accept 10 MB images, persist ordering and clean partial uploads', async t => {
  const mongo = await MongoMemoryServer.create(); t.after(() => mongo.stop())
  const client = createClient(readConfig({ MONGODB_URI: mongo.getUri('gallery') }))
  await client.connect(); t.after(() => client.close())
  const db = client.db(); await initializeDatabase(db)
  const authRepository = createAuthRepository(db), activityRepository = createActivityRepository(db)
  const user = await authRepository.createUser({ name: 'Gallery Host', email: 'gallery@example.com', passwordHash: 'unused' })
  await db.collection('users').updateOne({ id: user.id }, { $set: { email_verified: true } })
  const token = newToken()
  await authRepository.createSession({ userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 120000) })
  const removed = []; let sequence = 0
  const coverStorage = { async upload() { const id = `gallery-${++sequence}`; return { publicId: id, url: `https://res.cloudinary.com/test/${id}.webp` } }, async remove(id) { removed.push(id) } }
  const server = createApp(readConfig({}), { authRepository, activityRepository, coverStorage }).listen(0, '127.0.0.1')
  await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)))
  const req = async (path, method, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/activities${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: response.status === 204 ? null : await response.json() }
  }
  const image = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#228833' } }).png().toBuffer()
  const base64 = image.toString('base64')
  const large = Buffer.concat([image, Buffer.alloc(10 * 1024 * 1024 - image.length)]).toString('base64')
  const body = { title: 'Gallery meetup', description: 'Multiple photos', category: 'Ăn uống', location: 'Saigon', startsAt: '2099-01-05T12:00:00Z', endsAt: '2099-01-05T14:00:00Z', estimatedCost: 150000, maxParticipants: 6 }
  const created = await req('', 'POST', { ...body, photosBase64: [large, base64] })
  assert.equal(created.status, 201)
  const id = created.body.activity.id
  assert.deepEqual(created.body.activity.imageUrls, ['https://res.cloudinary.com/test/gallery-1.webp', 'https://res.cloudinary.com/test/gallery-2.webp'])
  assert.equal(created.body.activity.imageUrl, created.body.activity.imageUrls[0])
  assert.equal(created.body.activity.financialConfig, undefined)
  assert.equal(created.body.activity.imagePublicIds, undefined)
  assert.deepEqual((await req(`/${id}`, 'GET')).body.activity.imageUrls, created.body.activity.imageUrls)
  assert.equal((await req('', 'POST', { ...body, photosBase64: Array(7).fill(base64) })).status, 400)
  assert.equal((await req('', 'POST', { ...body, coverBase64: base64, photosBase64: [base64] })).status, 400)
  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')
  assert.equal((await req(`/${id}`, 'PATCH', { photosBase64: [oversized] })).status, 413)
  assert.equal((await req(`/${id}`, 'PATCH', { photosBase64: [base64, 'AAAA'] })).status, 400)
  assert.ok(removed.includes('gallery-3'))
  assert.equal((await activityRepository.get(id)).imageUrls.length, 2)
  const replaced = await req(`/${id}`, 'PATCH', { photosBase64: [base64] })
  assert.equal(replaced.status, 200)
  assert.ok(removed.includes('gallery-1')); assert.ok(removed.includes('gallery-2'))
  const cleared = await req(`/${id}`, 'PATCH', { photosBase64: [] })
  assert.equal(cleared.status, 200); assert.deepEqual(cleared.body.activity.imageUrls, [])
  assert.ok(removed.includes('gallery-4'))
  await req(`/${id}`, 'PATCH', { photosBase64: [base64, base64] })
  assert.equal((await req(`/${id}`, 'DELETE')).status, 204)
  assert.ok(removed.includes('gallery-5')); assert.ok(removed.includes('gallery-6'))
})
