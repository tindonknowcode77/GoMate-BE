import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { readConfig } from '../src/config/env.js'
import { createApp } from '../src/app.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { hashToken, newToken } from '../src/modules/auth/token.js'
import { createActivityRepository } from '../src/modules/activities/repository.js'
import { seedUserFriends } from '../src/database/seed-user-friends.js'

test('account drafts preserve incomplete steps/media, reject stale writes and stay private', async t => {
  const mongo = await MongoMemoryServer.create(), client = createClient(readConfig({ MONGODB_URI: mongo.getUri('drafts') })); await client.connect(); const db = client.db(); await initializeDatabase(db)
  t.after(async () => { await client.close(); await mongo.stop() })
  const repository = createAuthRepository(db), first = newToken(), second = newToken()
  repository.findSession = async hash => { const id = hash === hashToken(first) ? 'owner' : hash === hashToken(second) ? 'other' : null; return id ? { user: { id }, expiresAt: new Date(Date.now() + 60000) } : null }
  const server = createApp(readConfig({}), { authRepository: repository }).listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const base = `http://127.0.0.1:${server.address().port}/api/activity-draft`
  const request = async (method = 'GET', body, token = first) => { const response = await fetch(base, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, data: response.status === 204 ? null : await response.json() } }
  assert.equal((await request('GET', undefined, null)).status, 401)
  const state = { step: 1, customCategory: false, data: { name: '', description: '', photos: [] } }
  assert.equal((await request('PUT', { version: 0, state })).status, 200)
  assert.equal((await request('GET', undefined, second)).data.draft, null)
  assert.equal((await request()).data.draft.state.data.name, '')
  assert.equal((await request('PUT', { version: 0, state })).status, 409)
  assert.equal((await request('PUT', { version: 1, state: { ...state, data: { ...state.data, ownerId: 'other' } } })).status, 400)
  const photo = Buffer.alloc(7 * 1024 * 1024, 120).toString('base64')
  const large = { step: 3, customCategory: true, data: { ...state.data, name: 'Unfinished trip', photos: [{ base64: photo, uri: 'blob:expired-after-reload' }, { base64: photo }], reservedSeats: 1, companions: [{ name: 'Lan Anh', note: 'Mang máy ảnh' }], planAttachment: { name: 'trip.xls', base64: 'YWJj' } } }
  const saved = await request('PUT', { version: 1, state: large }); assert.equal(saved.status, 200); assert.equal(saved.data.version, 2)
  const restored = (await request()).data.draft
  assert.equal(restored.state.step, 3); assert.equal(restored.state.data.photos[0].base64, photo); assert.equal(restored.state.data.photos[0].uri, undefined); assert.equal(restored.state.data.companions[0].name, 'Lan Anh'); assert.equal(restored.state.data.planAttachment.base64, 'YWJj')
  assert.equal(await db.collection('activity_draft_data.files').countDocuments(), 1)
  assert.equal((await request('DELETE', { version: 2 }, second)).status, 204); assert.ok((await request()).data.draft)
  assert.equal((await request('DELETE', { version: 1 })).status, 409)
  assert.equal((await request('DELETE', { version: 2 })).status, 204); assert.equal((await request()).data.draft, null)
  assert.equal(await db.collection('activity_draft_data.files').countDocuments(), 0); assert.equal(await db.collection('activity_draft_data.chunks').countDocuments(), 0)
})

test('friend seeding is additive, complete and idempotent for the requested account', async t => {
  const mongo = await MongoMemoryServer.create(), client = createClient(readConfig({ MONGODB_URI: mongo.getUri('friend_seed') })); await client.connect(); const db = client.db(); await initializeDatabase(db)
  t.after(async () => { await client.close(); await mongo.stop() })
  await db.collection('users').insertOne({ id: 'owner', email: 'pminh2004@gmail.com', name: 'Preserve owner', password_hash: 'unchanged' })
  await seedUserFriends(db, 'pminh2004@gmail.com', 'demo-test-password')
  await seedUserFriends(db, 'pminh2004@gmail.com', 'another-password-not-overwritten')
  const users = await db.collection('users').find({ demo_seed: 'pminh-friends' }).toArray()
  assert.equal(users.length, 5); assert.equal(new Set(users.map(user => user.avatar_url)).size, 5)
  assert.ok(users.every(user => user.name && user.birthDate && user.gender && user.bio && user.languages.length && user.interests.length && user.occupation && user.email_verified))
  assert.equal(await db.collection('friendships').countDocuments({ participantIds: 'owner', status: 'accepted' }), 5)
  assert.equal((await db.collection('users').findOne({ id: 'owner' })).password_hash, 'unchanged')
  const activities = createActivityRepository(db)
  const activity = await activities.create({ title: 'Member portraits', initialMembers: [users[0]], reservedSeats: 1, maxParticipants: 6, startsAt: new Date('2099-01-01') }, { id: 'owner', name: 'Owner' })
  await db.collection('activities').updateOne({ id: activity.id }, { $push: { joinRequests: { id: 'pending', userId: users[1].id, status: 'pending' } } })
  const owned = await activities.owned('owner', 1, 20)
  assert.equal(owned.items[0].memberAvatars.length, 2)
  assert.equal(owned.items[0].memberAvatars[0].avatarUrl, null)
  assert.equal(owned.items[0].memberAvatars[1].avatarUrl, users[0].avatar_url)
  assert.equal(owned.items[0].memberAvatars.some(person => person.userId === users[1].id), false)
  await db.collection('users').updateOne({ id: users[0].id }, { $set: { avatar_url: 'https://example.com/new-profile.jpg' } })
  const joined = await activities.participating(users[0].id, { page: 1, limit: 20 }, false)
  assert.equal(joined.items[0].memberAvatars[1].avatarUrl, 'https://example.com/new-profile.jpg')

})
