import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import sharp from 'sharp'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { createActivityRepository } from '../src/modules/activities/repository.js'
import { createChatRepository } from '../src/modules/chat/repository.js'
import { hashToken, newToken } from '../src/modules/auth/token.js'

test('shared chat content and companion profiles persist with membership and owner authorization', async t => {
  const mongo = await MongoMemoryServer.create(); t.after(() => mongo.stop())
  const client = createClient(readConfig({ MONGODB_URI: mongo.getUri('chat_content') })); await client.connect(); t.after(() => client.close())
  const db = client.db(); await initializeDatabase(db)
  const auth = createAuthRepository(db), activities = createActivityRepository(db), chat = createChatRepository(db), users = [], tokens = []
  for (let i = 0; i < 3; i++) {
    const user = await auth.createUser({ name: `Content user ${i}`, email: `content${i}@example.com`, passwordHash: 'unused' })
    await db.collection('users').updateOne({ id: user.id }, { $set: { email_verified: true, avatar_url: 'https://res.cloudinary.com/demo/image/upload/sample.jpg' } })
    const token = newToken(); await auth.createSession({ userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 600000) }); users.push(user); tokens.push(token)
  }
  const server = createApp(readConfig({}), { authRepository: auth, activityRepository: activities, chatRepository: chat }).listen(0, '127.0.0.1')
  await once(server, 'listening'); t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const base = `http://127.0.0.1:${server.address().port}/api`
  const request = async (path, method = 'GET', body, who = 0) => {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  }
  const draft = { title: 'Shared media trip', description: 'Go together', category: 'Du lịch', location: 'Hà Nội', startsAt: '2099-01-01T02:00:00.000Z', endsAt: '2099-01-02T11:00:00.000Z', estimatedCost: 0, maxParticipants: 5, reservedSeats: 2, companions: [{ name: 'Lan', note: 'Thích chụp ảnh' }, { name: 'Minh', note: 'Mang lều' }] }
  assert.equal((await request('/activities', 'POST', { ...draft, companions: null })).status, 400)
  const created = await request('/activities', 'POST', draft); assert.equal(created.status, 201)
  const activityId = created.body.activity.id, companionPath = `/activities/${activityId}/companions`
  const join = await activities.submitJoinRequest(activityId, users[1]); await activities.changeJoinRequest(activityId, { hostId: users[0].id, requestId: join.id, status: 'approved' })
  const conversation = (await request('/conversations', 'POST', { type: 'group', activityId })).body.conversation.id
  const path = `/conversations/${conversation}`
  await t.test('named companions are private, host editable, versioned and never chat accounts', async () => {
    const current = await request(companionPath)
    assert.deepEqual(current.body.companions, draft.companions)
    assert.equal((await request(companionPath, 'GET', undefined, 2)).status, 403)
    assert.equal((await request(companionPath, 'GET', undefined, 1)).body.companions[1].name, 'Minh')
    assert.equal((await request(companionPath, 'PATCH', { version: current.body.version, companions: draft.companions }, 1)).status, 403)
    assert.equal((await request(companionPath, 'PATCH', { version: 0, companions: [] })).status, 409)
    const changed = [{ name: 'Lan Anh', note: 'Máy ảnh' }, draft.companions[1]]
    assert.equal((await request(companionPath, 'PATCH', { version: current.body.version, companions: changed })).status, 200)
    assert.deepEqual((await request(companionPath)).body.companions, changed)
    assert.equal((await request(`/activities/${activityId}`, 'GET', undefined, 2)).body.activity.companions, undefined)
    assert.equal((await request(`/activities/${activityId}`)).body.activity.hostAvatarUrl, 'https://res.cloudinary.com/demo/image/upload/sample.jpg')
    const feed = await request('/activities', 'GET', undefined, 2)
    assert.equal(feed.body.items[0].companions, undefined); assert.ok(feed.body.items[0].hostAvatarUrl)
    assert.equal((await request(`/activities/${activityId}/members`)).body.total, 2)
    const before = await activities.get(activityId)
    await activities.addFriends(before, [users[2]], true)
    const after = await activities.get(activityId)
    assert.equal(after.memberCount, before.memberCount); assert.equal(after.reservedSeats, 1)
    assert.deepEqual(after.companions, [draft.companions[1]])
  })
  const image = await sharp({ create: { width: 12, height: 12, channels: 3, background: 'purple' } }).png().toBuffer()
  const upload = async (buffer, name, who = 0, target = path) => {
    const form = new FormData(); form.append('file', new Blob([buffer]), name)
    const response = await fetch(base + target + '/attachments', { method: 'POST', headers: { Authorization: `Bearer ${tokens[who]}` }, body: form })
    return { status: response.status, body: await response.json() }
  }
  let photo, pdf
  await t.test('uploads validate bytes, names, file limit and pending visibility', async () => {
    assert.equal((await upload(Buffer.from('<svg onload="alert(1)"></svg>'), 'fake.png')).status, 400)
    assert.equal((await upload(Buffer.alloc(10 * 1024 * 1024 + 1), 'large.txt')).status, 413)
    photo = await upload(image, 'photo.png'); assert.equal(photo.status, 201); assert.equal(photo.body.attachment.kind, 'image')
    pdf = await upload(Buffer.from('%PDF-1.4\nSample file'), 'kế hoạch.pdf'); assert.equal(pdf.status, 201); assert.equal(pdf.body.attachment.name, 'kế hoạch.pdf')
    assert.equal((await fetch(base + `${path}/attachments/${photo.body.attachment.id}`, { headers: { Authorization: `Bearer ${tokens[1]}` } })).status, 404)
    assert.equal((await request(path + '/shared?kind=media', 'GET', undefined, 1)).body.items.length, 0)
    const indexes = await db.collection('chat_attachments').indexes(); assert.ok(indexes.some(item => item.expireAfterSeconds === 0))
  })
  let messageId
  await t.test('media, location and links persist, retry idempotently and appear in paginated libraries', async () => {
    const body = { text: 'Plan https://example.com/trip.', clientMessageId: 'content-one', attachmentIds: [photo.body.attachment.id, pdf.body.attachment.id], location: { latitude: 10.77, longitude: 106.69, label: 'Điểm hẹn' } }
    assert.equal((await request(path + '/messages', 'POST', body, 1)).status, 400)
    const results = await Promise.all([request(path + '/messages', 'POST', body), request(path + '/messages', 'POST', body)])
    assert.equal(results[0].status, 200); assert.equal(results[1].status, 200)
    messageId = results[0].body.message.id; assert.equal(messageId, results[1].body.message.id)
    const item = results[0].body.message
    assert.equal(item.attachments.length, 2); assert.equal(item.location.latitude, 10.77); assert.deepEqual(item.links, ['https://example.com/trip'])
    assert.equal((await request(path + '/messages', 'POST', { ...body, location: { ...body.location, latitude: 11 } })).status, 409)
    assert.equal((await request(path + '/messages', 'POST', { text: 'Retry after editing draft', clientMessageId: 'reuse', attachmentIds: body.attachmentIds })).status, 200)
    assert.equal((await request(path + '/messages', 'POST', { text: '', clientMessageId: 'location-only', location: { latitude: 21, longitude: 105, label: '' } })).status, 200)
    assert.equal((await request(path + '/messages', 'POST', { text: '', clientMessageId: 'bad-coordinate', location: { latitude: 100, longitude: 0, label: '' } })).status, 400)
    for (const kind of ['media', 'files', 'links', 'locations']) assert.ok((await request(path + '/shared?kind=' + kind, 'GET', undefined, 1)).body.items.some(row => row.id === messageId))
    const page = await request(path + '/shared?kind=locations&limit=1'); assert.equal(page.body.hasMore, true)
    const next = await request(path + '/shared?kind=locations&limit=1&before=' + page.body.nextCursor); assert.equal(next.body.items[0].id, messageId)
    const stored = await db.collection('chat_attachments').findOne({ conversationId: conversation, name: 'photo.png' }); assert.equal(stored.expiresAt, undefined)
    const download = await fetch(base + `${path}/attachments/${photo.body.attachment.id}`, { headers: { Authorization: `Bearer ${tokens[1]}` } })
    assert.equal(download.status, 200); assert.match(download.headers.get('cache-control'), /no-store/); assert.deepEqual(Buffer.from(await download.arrayBuffer()), image)
    const partial = await fetch(base + `${path}/attachments/${photo.body.attachment.id}`, { headers: { Authorization: `Bearer ${tokens[1]}`, Range: 'bytes=2-8' } }); assert.equal(partial.status, 206); assert.deepEqual(Buffer.from(await partial.arrayBuffer()), image.subarray(2, 9))
    const invalidRange = await fetch(base + `${path}/attachments/${photo.body.attachment.id}`, { headers: { Authorization: `Bearer ${tokens[1]}`, Range: 'bytes=900000-' } }); assert.equal(invalidRange.status, 416)
    const direct = (await request('/conversations', 'POST', { type: 'direct', userId: users[1].id })).body.conversation.id
    assert.equal((await request(`/conversations/${direct}/messages`, 'POST', { text: '', clientMessageId: 'cross', attachmentIds: [photo.body.attachment.id] })).status, 400)
  })
  await t.test('removing a member revokes attachment and library access immediately', async () => {
    await activities.removeMember(activityId, users[1].id, users[0].id, true)
    assert.equal((await request(path + '/shared?kind=links', 'GET', undefined, 1)).status, 403)
    assert.equal((await fetch(base + `${path}/attachments/${pdf.body.attachment.id}`, { headers: { Authorization: `Bearer ${tokens[1]}` } })).status, 403)
    assert.equal((await request(companionPath, 'GET', undefined, 1)).status, 403)
  })
})
