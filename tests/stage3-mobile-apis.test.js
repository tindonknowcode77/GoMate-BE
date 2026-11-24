import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { PDFDocument } from 'pdf-lib'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { createActivityRepository } from '../src/modules/activities/repository.js'
import { createChatRepository } from '../src/modules/chat/repository.js'
import { newToken, hashToken } from '../src/modules/auth/token.js'

const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

test('Stage 3 mobile APIs: multi-format plans, bulk/QR attendance, memories album and descriptive chat updates', async t => {
  const mongod = await MongoMemoryServer.create()
  const config = readConfig({ MONGODB_URI: mongod.getUri('stage3_apis') })
  const client = createClient(config)
  await client.connect()
  const db = client.db()
  await initializeDatabase(db)
  const authRepo = createAuthRepository(db)
  const activityRepo = createActivityRepository(db)
  const chatRepo = createChatRepository(db)
  const fakeStorage = {
    upload: async (_buf, owner) => ({ url: `https://res.cloudinary.com/demo/image/upload/${owner}-${Date.now()}.webp`, publicId: `pub-${Date.now()}` }),
    remove: async () => {},
  }
  const app = createApp(config, { authRepository: authRepo, activityRepository: activityRepo, chatRepository: chatRepo, coverStorage: fakeStorage })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}/api`

  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    await client.close()
    await mongod.stop()
  })

  async function makeUser(email, name) {
    const user = await authRepo.createUser({ email, name, passwordHash: 'hash' })
    await db.collection('users').updateOne({ id: user.id }, { $set: { email_verified: true } })
    const token = newToken()
    await authRepo.createSession({ tokenHash: hashToken(token), userId: user.id, expiresAt: new Date(Date.now() + 86400000) })
    return { ...user, token }
  }
  async function call(token, path, method = 'GET', body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }

  const host = await makeUser('host@stage3.test', 'Host S3')
  const m1 = await makeUser('m1@stage3.test', 'Member 1')
  const m2 = await makeUser('m2@stage3.test', 'Member 2')
  const startsAt = new Date(Date.now() + 48 * 3600000)
  const endsAt = new Date(startsAt.getTime() + 3 * 3600000)

  const pdf = await PDFDocument.create()
  pdf.addPage()
  const pdfBase64 = Buffer.from(await pdf.save()).toString('base64')

  const created = await call(host.token, '/activities', 'POST', {
    title: 'Picnic cuối tuần',
    category: 'Cà phê',
    location: 'Quận 1, TP.HCM',
    address: '10 Lê Lợi',
    province: 'TP. Hồ Chí Minh',
    meetingPoint: 'Cổng A',
    description: 'Đi chơi cuối tuần vui vẻ',
    estimatedCost: 100000,
    minParticipants: 2,
    maxParticipants: 10,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    planAttachment: { name: 'lich-trinh.pdf', base64: pdfBase64 },
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const act = created.body.activity
  assert.equal(act.planFile.mimeType, 'application/pdf')

  // Reject spoofed PDF bytes
  const fakePdf = await call(host.token, `/activities/${act.id}/plan`, 'PATCH', {
    version: act.version,
    planAttachment: { name: 'spoof.pdf', base64: Buffer.from('not-a-pdf').toString('base64') },
  })
  assert.equal(fakePdf.status, 400)

  // Approve m1 and m2
  for (const m of [m1, m2]) {
    const req = (await call(m.token, `/activities/${act.id}/join-requests`, 'POST', {})).body.request
    assert.equal((await call(host.token, `/activities/${act.id}/join-requests/${req.id}`, 'PATCH', { status: 'approved' })).status, 200)
  }

  // Host edits activity -> descriptive system message appears in group chat
  const edited = await call(host.token, `/activities/${act.id}`, 'PATCH', {
    meetingPoint: 'Cổng B (đối diện công viên)',
  })
  assert.equal(edited.status, 200, JSON.stringify(edited.body))
  const conv = (await call(m1.token, '/conversations', 'POST', { type: 'group', activityId: act.id })).body.conversation
  const msgs = (await call(m1.token, `/conversations/${conv.id}/messages`)).body.items
  assert.ok(msgs.some(m => m.text.includes('Điểm tập trung')), 'Descriptive update message should appear in chat')

  // Bulk attendance: mark all present, override m2 absent
  const bulk = await call(host.token, `/activities/${act.id}/attendance/bulk`, 'PUT', {
    markAll: 'present',
    items: [{ userId: m2.id, status: 'absent' }],
  })
  assert.equal(bulk.status, 200)
  assert.equal(bulk.body.items.find(i => i.userId === m1.id).status, 'present')
  assert.equal(bulk.body.items.find(i => i.userId === m2.id).status, 'absent')

  // Reset m2 to unmarked, then check in via rotating QR token
  await call(host.token, `/activities/${act.id}/attendance/${m2.id}`, 'PATCH', { status: 'unmarked' })
  const qrRes = await call(host.token, `/activities/${act.id}/attendance/qr-token`, 'POST', {})
  assert.equal(qrRes.status, 200)
  assert.ok(qrRes.body.qr.token.startsWith('GMQR1.'))

  // Tampered QR token rejected
  assert.equal((await call(m2.token, `/activities/${act.id}/attendance/qr-checkin`, 'POST', { token: qrRes.body.qr.token + 'x' })).status, 400)

  // Valid QR check-in succeeds
  const checkin = await call(m2.token, `/activities/${act.id}/attendance/qr-checkin`, 'POST', { token: qrRes.body.qr.token })
  assert.equal(checkin.status, 200)
  assert.equal(checkin.body.attendance.status, 'present')
  assert.equal(checkin.body.attendance.checkedInMethod, 'qr')

  // GPS check-in: reset m2 to unmarked, add coordinates to activity, reject far GPS (>300m), accept near GPS (<=300m)
  await call(host.token, `/activities/${act.id}/attendance/${m2.id}`, 'PATCH', { status: 'unmarked' })
  await db.collection('activities').updateOne({ id: act.id }, { $set: { coordinates: { type: 'Point', coordinates: [106.7009, 10.7769] } } })
  const farGps = await call(m2.token, `/activities/${act.id}/attendance/gps-checkin`, 'POST', { latitude: 10.79, longitude: 106.72 })
  assert.equal(farGps.status, 409)
  const nearGps = await call(m2.token, `/activities/${act.id}/attendance/gps-checkin`, 'POST', { latitude: 10.777, longitude: 106.701 })
  assert.equal(nearGps.status, 200, JSON.stringify(nearGps.body))
  assert.equal(nearGps.body.attendance.status, 'present')
  assert.equal(nearGps.body.attendance.checkedInMethod, 'gps')
  assert.ok(nearGps.body.distanceMeters <= 300)

  // Upload memory photo -> shows in memories list AND summary
  const mem = await call(m1.token, `/activities/${act.id}/memories`, 'POST', {
    imageBase64: tinyPng,
    caption: 'Khoảnh khắc đẹp cùng cả nhóm!',
  })
  assert.equal(mem.status, 201, JSON.stringify(mem.body))
  const memList = await call(m2.token, `/activities/${act.id}/memories`)
  assert.equal(memList.body.total, 1)
  assert.equal(memList.body.items[0].caption, 'Khoảnh khắc đẹp cùng cả nhóm!')

  // Complete activity and check summary includes memories
  const cur2 = await activityRepo.get(act.id)
  assert.equal((await call(host.token, `/activities/${act.id}/confirm-schedule`, 'POST', { version: cur2.version })).status, 200)
  assert.equal((await call(host.token, `/activities/${act.id}/start`, 'POST', {})).status, 200)
  assert.equal((await call(host.token, `/activities/${act.id}/complete`, 'POST', {})).status, 200)

  const summary = await call(m1.token, `/activities/${act.id}/summary`)
  assert.equal(summary.status, 200)
  assert.equal(summary.body.summary.memories.length, 1)
  assert.equal(summary.body.summary.attendance.presentCount, 3)

  // Delete memory
  assert.equal((await call(m1.token, `/activities/${act.id}/memories/${mem.body.memory.id}`, 'DELETE')).status, 204)
  assert.equal((await call(m2.token, `/activities/${act.id}/memories`)).body.total, 0)

  // Nearby GPS radar: m1 shares presence near District 1, m2 scans nearby and finds m1, then m1 hides presence
  const shareRes = await call(m1.token, '/friends/nearby/presence', 'PUT', { enabled: true, latitude: 10.7769, longitude: 106.7009 })
  assert.equal(shareRes.status, 200)
  assert.equal(shareRes.body.presence.enabled, true)

  const scanRes = await call(m2.token, '/friends/nearby?lat=10.778&lng=106.702&radiusKm=5')
  assert.equal(scanRes.status, 200)
  const foundM1 = scanRes.body.items.find(u => u.id === m1.id)
  assert.ok(foundM1, 'm2 should discover m1 nearby')
  assert.ok(foundM1.distanceKm <= 5)

  const hideRes = await call(m1.token, '/friends/nearby/presence', 'PUT', { enabled: false })
  assert.equal(hideRes.status, 200)
  assert.equal(hideRes.body.presence.enabled, false)
  const scanAfterHide = await call(m2.token, '/friends/nearby?lat=10.778&lng=106.702&radiusKm=5')
  assert.equal(scanAfterHide.body.items.find(u => u.id === m1.id), undefined)
})
