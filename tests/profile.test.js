import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import sharp from 'sharp'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { hashToken, newToken } from '../src/modules/auth/token.js'

test('profiles and avatars persist with owner-only writes', async t => {
  const mongo = await MongoMemoryServer.create()
  t.after(() => mongo.stop())
  const client = createClient(readConfig({ MONGODB_URI: mongo.getUri('profile_test') }))
  await client.connect()
  t.after(() => client.close())
  const db = client.db()
  await initializeDatabase(db)
  const repository = createAuthRepository(db)
  const images = new Map()
  const removed = []
  let uploadFails = false
  let sequence = 0
  const avatarStorage = {
    async upload(data, id) {
      if (uploadFails) { const error = new Error('Cloud upload unavailable'); error.status = 502; throw error }
      const publicId = `gomate/avatars/${id}/${++sequence}`
      images.set(publicId, data)
      return { publicId, url: `https://res.cloudinary.com/test/image/upload/${publicId}.webp` }
    },
    async remove(id) { removed.push(id); images.delete(id) },
  }
  const users = []
  const tokens = []
  for (let i = 0; i < 2; i++) {
    const user = await repository.createUser({ name: `User ${i}`, email: `user${i}@example.com`, passwordHash: 'not-exposed' })
    await db.collection('users').updateOne({ id: user.id }, { $set: { email_verified: true } })
    users.push(user)
    tokens.push(newToken())
    await repository.createSession({ userId: user.id, tokenHash: hashToken(tokens[i]), expiresAt: new Date(Date.now() + 60000) })
  }
  const server = createApp(readConfig({}), { authRepository: repository, avatarStorage }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = async (path, method = 'GET', body, token = tokens[0]) => {
    const response = await fetch(`${base}/api/profile${path}`, { method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json(), headers: response.headers }
  }

  await t.test('requires a live session and returns only profile fields', async () => {
    assert.equal((await request('/me', 'GET', undefined, '')).status, 401)
    assert.equal((await request('/me', 'PATCH', { name: 'Hacked' }, newToken())).status, 401)
    assert.equal((await request('/me/avatar', 'PUT', { base64: 'AAAA' }, '')).status, 401)
    const result = await request('/me')
    assert.equal(result.status, 200)
    assert.equal(result.body.profile.name, users[0].name)
    assert.equal(result.body.profile.avatarUrl, null)
    assert.deepEqual(Object.keys(result.body.profile).sort(), ['activityWish', 'age', 'alcohol', 'availableTimes', 'avatarUrl', 'basicProfileComplete', 'bio', 'birthDate', 'companionGoal', 'contribution', 'coverUrl', 'demo', 'education', 'email', 'emailVerified', 'gender', 'id', 'interests', 'languages', 'location', 'missingFields', 'name', 'occupation', 'photos', 'profileComplete', 'religion', 'school', 'username'])
    assert.equal(result.body.profile.profileComplete, false)
    assert.ok(result.body.profile.missingFields.includes('languages'))
    assert.equal(result.headers.get('cache-control'), 'no-store')
    const publicResult = await request(`/${users[1].id}`)
    assert.equal(publicResult.status, 200)
    for (const field of ['email', 'birthDate', 'gender', 'religion', 'alcohol', 'password_hash']) assert.equal(publicResult.body.profile[field], undefined)
  })
  await t.test('updates allowed fields, normalizes usernames and preserves other fields', async () => {
    const result = await request('/me', 'PATCH', { name: ' New Name ', username: '@New_Name', bio: 'Hello', location: 'Ha Noi', interests: ['Coffee', 'Coffee', 'Travel'] })
    assert.equal(result.status, 200)
    assert.equal(result.body.profile.username, 'new_name')
    assert.deepEqual(result.body.profile.interests, ['Coffee', 'Travel'])
    await request('/me', 'PATCH', { bio: 'Updated' })
    const persisted = await createAuthRepository(db).getProfile(users[0].id)
    assert.equal(persisted.name, 'New Name')
    assert.equal(persisted.bio, 'Updated')
    assert.equal((await request('/me', 'GET', undefined, tokens[1])).body.profile.name, users[1].name)
    assert.equal((await request('/me', 'PATCH', { username: 'NEW_NAME' }, tokens[1])).status, 409)
    assert.equal((await request('/me', 'PATCH', { username: '' })).status, 200)
    assert.equal((await request('/me', 'PATCH', { username: 'new_name' }, tokens[1])).status, 200)
  })
  await t.test('rejects invalid fields, operators and attempts to change another user or credentials', async () => {
    for (const body of [{}, { id: users[1].id }, { email: 'hijacked@example.com' }, { role: 'admin' }, { avatarUrl: 'https://example.com' },
      { $set: { name: 'No' } }, { name: 'A' }, { username: '../no' }, { bio: 'x'.repeat(501) }, { interests: [null] }]) {
      assert.equal((await request('/me', 'PATCH', body)).status, 400)
    }
    assert.equal((await repository.findUserByEmail(users[0].email)).name, 'New Name')
  })
  await t.test('completion follows persisted basic fields and sensitive preferences stay optional', async () => {
    const result = await request('/me', 'PATCH', { name: 'Profile User', bio: 'Hello', location: 'TP.HCM', interests: ['Cà phê'], languages: ['Tiếng Việt'], birthDate: '2000-01-01', gender: 'other', religion: 'undisclosed', alcohol: 'no' })
    assert.equal(result.status, 200)
    assert.equal(result.body.profile.profileComplete, true)
    assert.equal(result.body.profile.gender, 'other')
    const incomplete = await request('/me', 'PATCH', { birthDate: '' })
    assert.equal(incomplete.body.profile.profileComplete, false)
    assert.ok(incomplete.body.profile.missingFields.includes('birthDate'))
    assert.equal((await request('/me', 'PATCH', { birthDate: '2000-01-01' })).body.profile.profileComplete, true)
    assert.equal((await request('/me')).body.profile.languages[0], 'Tiếng Việt')
    assert.equal((await request('/me', 'PATCH', { languages: [] })).body.profile.profileComplete, false)
    for (const body of [{ languages: ['a'.repeat(41)] }, { gender: 'invalid' }, { religion: '$gt' }, { alcohol: 'sometimes' }, { birthDate: '2099-01-01' }, { birthDate: '2000-02-30' }, { profileComplete: true }]) assert.equal((await request('/me', 'PATCH', body)).status, 400)
  })
  let avatarUrl
  await t.test('re-encodes avatar for Cloudinary, persists URL and removes replaced cloud image', async () => {
    const input = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#008800' } }).png().toBuffer()
    const result = await request('/me/avatar', 'PUT', { base64: input.toString('base64') })
    assert.equal(result.status, 200)
    avatarUrl = result.body.profile.avatarUrl
    assert.match(avatarUrl, /^https:\/\/res.cloudinary.com\//)
    const saved = await db.collection('users').findOne({ id: users[0].id })
    assert.equal(saved.avatar, undefined)
    assert.equal(saved.avatar_url, avatarUrl)
    const buffer = images.get(saved.avatar_public_id)
    const metadata = await sharp(buffer).metadata()
    assert.equal(metadata.width, 512)
    assert.equal(metadata.height, 512)
    assert.equal(metadata.exif, undefined)
    assert.equal((await createAuthRepository(db).getProfile(users[0].id)).avatar_url, avatarUrl)
    const redirect = await fetch(`${base}/api/profile/${users[0].id}/avatar`, { redirect: 'manual' })
    assert.equal(redirect.status, 302)
    assert.equal(redirect.headers.get('location'), avatarUrl)
    assert.equal((await request('/me', 'GET', undefined, tokens[1])).body.profile.avatarUrl, null)
    const replacement = await request('/me/avatar', 'PUT', { base64: input.toString('base64') })
    assert.notEqual(replacement.body.profile.avatarUrl, avatarUrl)
    avatarUrl = replacement.body.profile.avatarUrl
    assert.ok(removed.includes(saved.avatar_public_id))
  })
  await t.test('accepts local file multipart uploads and preserves avatar when provider fails', async () => {
    const input = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#000000' } }).png().toBuffer()
    const sendFile = (field, data) => {
      const body = new FormData()
      body.append(field, new Blob([data], { type: 'image/png' }), 'local-photo.png')
      return fetch(`${base}/api/profile/me/avatar`, { method: 'PUT', headers: { Authorization: `Bearer ${tokens[0]}` }, body })
    }
    let response = await sendFile('avatar', input)
    assert.equal(response.status, 200)
    avatarUrl = (await response.json()).profile.avatarUrl
    assert.equal((await sendFile('wrongField', input)).status, 400)
    const tenMb = Buffer.concat([input, Buffer.alloc(10 * 1024 * 1024 - input.length)])
    assert.equal((await sendFile('avatar', tenMb)).status, 200)
    const uploaded = await request('/me/avatar', 'PUT', { base64: tenMb.toString('base64') })
    assert.equal(uploaded.status, 200)
    avatarUrl = uploaded.body.profile.avatarUrl
    assert.equal((await sendFile('avatar', Buffer.alloc(10 * 1024 * 1024 + 1))).status, 413)
    uploadFails = true
    response = await sendFile('avatar', input)
    assert.equal(response.status, 502)
    uploadFails = false
    assert.equal((await request('/me')).body.profile.avatarUrl, avatarUrl)
  })
  await t.test('rejects oversized, corrupt and SVG uploads without replacing the last valid avatar', async () => {
    for (const base64 of ['bad', 'AAAA', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>').toString('base64')]) {
      assert.equal((await request('/me/avatar', 'PUT', { base64 })).status, 400)
    }
    assert.equal((await request('/me/avatar', 'PUT', { base64: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') })).status, 413)
    assert.equal((await request('/me/avatar', 'PUT', { base64: 'A'.repeat(14 * 1024 * 1024 + 4) })).status, 413)
    assert.equal((await request('/me')).body.profile.avatarUrl, avatarUrl)
    assert.equal((await fetch(`${base}/api/profile/${users[1].id}/avatar`)).status, 404)
  })
  await t.test('basic onboarding saves independently from companion profile details', async () => {
    const basic = await request('/me', 'PATCH', { name: 'GoMate User', birthDate: '2000-02-29', gender: 'undisclosed', location: 'Hà Nội', languages: ['Tiếng Việt'], bio: '', interests: [] })
    assert.equal(basic.body.profile.basicProfileComplete, true)
    assert.equal(basic.body.profile.profileComplete, false)
    assert.equal(basic.body.profile.emailVerified, true)
    const details = { bio: 'Finding activity buddies', interests: ['Chèo SUP', 'Lập trình'], occupation: 'Developer', school: 'University', education: 'Đại học', companionGoal: 'Thử trải nghiệm mới', availableTimes: ['Tối cuối tuần'], activityWish: 'Camping together', contribution: 'Photography' }
    const saved = await request('/me', 'PATCH', details)
    assert.equal(saved.body.profile.profileComplete, true)
    for (const [key, value] of Object.entries(details)) assert.deepEqual(saved.body.profile[key], value)
    const publicRow = (await request(`/${users[0].id}`)).body.profile
    assert.equal(publicRow.activityWish, details.activityWish)
    for (const key of ['emailVerified', 'birthDate', 'gender', 'religion', 'alcohol']) assert.equal(publicRow[key], undefined)
    assert.equal((await request('/me', 'PATCH', { activityWish: 'x'.repeat(301) })).status, 400)
    assert.equal((await request('/me', 'PATCH', { availableTimes: ['$'.repeat(41)] })).status, 400)
  })
  await t.test('profile gallery uploads, reorders and deletes only owned photos', async () => {
    const image = (await sharp({ create: { width: 30, height: 40, channels: 3, background: '#337799' } }).png().toBuffer()).toString('base64')
    assert.equal((await request('/me/photos', 'POST', { base64: image }, '')).status, 401)
    assert.equal((await request('/me/photos', 'POST', { base64: 'AAAA' })).status, 400)
    const first = await request('/me/photos', 'POST', { base64: image })
    assert.equal(first.status, 201)
    const second = await request('/me/photos', 'POST', { base64: image })
    assert.equal(second.body.profile.photos.length, 2)
    assert.deepEqual(Object.keys(second.body.profile.photos[0]).sort(), ['id', 'url'])
    const ids = second.body.profile.photos.map(photo => photo.id)
    assert.equal((await request('/me/photos', 'PATCH', { photoIds: ids }, tokens[1])).status, 400)
    assert.equal((await request('/me/photos', 'PATCH', { photoIds: [ids[0], ids[0]] })).status, 400)
    const reordered = await request('/me/photos', 'PATCH', { photoIds: [...ids].reverse() })
    assert.deepEqual(reordered.body.profile.photos.map(photo => photo.id), [...ids].reverse())
    const publicRow = (await request(`/${users[0].id}`)).body.profile
    assert.deepEqual(publicRow.photos, reordered.body.profile.photos)
    uploadFails = true
    try { assert.equal((await request('/me/photos', 'POST', { base64: image })).status, 502) } finally { uploadFails = false }
    assert.equal((await request('/me')).body.profile.photos.length, 2)
    const before = await repository.getProfile(users[0].id)
    assert.ok(await repository.replaceProfilePhotos(users[0].id, before, before.profile_photos))
    assert.equal(await repository.replaceProfilePhotos(users[0].id, before, []), null)
    assert.equal((await request('/me/photos', 'POST', { base64: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') })).status, 413)
    for (let index = 0; index < 4; index++) assert.equal((await request('/me/photos', 'POST', { base64: image })).status, 201)
    assert.equal((await request('/me/photos', 'POST', { base64: image })).status, 409)
    const cleared = await request('/me/photos', 'PATCH', { photoIds: [] })
    assert.deepEqual(cleared.body.profile.photos, [])
    for (const photo of before.profile_photos) assert.ok(removed.includes(photo.publicId))
  })
  await t.test('reviews show the current user actual scores and an honest empty state', async () => {
    assert.deepEqual((await request('/me/reviews')).body, { items: [], average: null, count: 0 })
    await db.collection('activity_ratings').insertMany([
      { id: 'review-1', targetUserId: users[0].id, score: 4, comment: 'Friendly', createdAt: new Date(), reviewerEmail: 'private@example.com' },
      { id: 'review-2', targetUserId: users[0].id, score: 5, createdAt: new Date() },
      { id: 'other-review', targetUserId: users[1].id, score: 1, createdAt: new Date() },
    ])
    const result = await request('/me/reviews')
    assert.equal(result.status, 200); assert.equal(result.body.average, 4.5); assert.equal(result.body.count, 2)
    assert.equal(result.body.items.length, 2)
    assert.equal(result.body.items[0].reviewerEmail, undefined)
    assert.equal((await request('/me', 'PATCH', { rating: 5 })).status, 400)
  })

})
