import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { createActivityRepository } from '../src/modules/activities/repository.js'
import { createChatRepository } from '../src/modules/chat/repository.js'
import { hashToken, newToken } from '../src/modules/auth/token.js'

test('trip plans, companion capacity, friends and early chat enforce identity and persist', async t => {
  const mongo = await MongoMemoryServer.create(); t.after(() => mongo.stop())
  const client = createClient(readConfig({ MONGODB_URI: mongo.getUri('trip_social') })); await client.connect(); t.after(() => client.close())
  const db = client.db(); await initializeDatabase(db)
  const auth = createAuthRepository(db), activities = createActivityRepository(db), chat = createChatRepository(db), users = [], tokens = []
  for (let i = 0; i < 5; i++) {
    const user = await auth.createUser({ name: 'Trip user ' + i, email: 'trip' + i + '@example.com', passwordHash: 'hidden' })
    await db.collection('users').updateOne({ id: user.id }, { $set: { email_verified: true, birthDate: i === 4 ? '2016-01-01' : '2000-01-01', gender: 'undisclosed', languages: ['Tiếng Việt'] } })
    const token = newToken(); await auth.createSession({ userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 600000) }); users.push(user); tokens.push(token)
  }
  const server = createApp(readConfig({}), { authRepository: auth, activityRepository: activities, chatRepository: chat }).listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)))
  const base = 'http://127.0.0.1:' + server.address().port
  const req = async (path, method = 'GET', body, user = 0) => {
    const response = await fetch(base + '/api' + path, { method, headers: { Authorization: 'Bearer ' + tokens[user], 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: response.status === 204 ? null : await response.json() }
  }
  const becomeFriends = async (target) => {
    const request = await req('/friends/requests', 'POST', { userId: users[target].id })
    assert.equal(request.status, 200)
    assert.equal((await req('/friends/requests/' + request.body.request.id, 'PATCH', { status: 'accepted' }, target)).status, 200)
  }
  await t.test('requests are unique, recipient-only, searchable and private', async () => {
    const pair = await Promise.all([req('/friends/requests', 'POST', { userId: users[1].id }), req('/friends/requests', 'POST', { userId: users[1].id })])
    assert.equal(pair[0].body.request.id, pair[1].body.request.id)
    assert.equal((await req('/friends/requests/' + pair[0].body.request.id, 'PATCH', { status: 'accepted' }, 2)).status, 409)
    assert.equal((await req('/friends/requests/' + pair[0].body.request.id, 'PATCH', { status: 'accepted' }, 1)).status, 200)
    assert.equal((await req('/friends')).body.items[0].id, users[1].id)
    const found = (await req('/friends/search?q=Trip')).body.items
    assert.ok(found.some(person => person.id === users[1].id && person.friendshipStatus === 'accepted'))
    assert.ok(found.every(person => !('email' in person) && !('birthDate' in person) && !('password_hash' in person)))
    assert.equal((await req('/friends/requests', 'POST', { userId: users[0].id })).status, 400)
    await becomeFriends(2); await becomeFriends(4)
  })
  const workbook = Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.from('Unparsed workbook bytes')])
  const draft = { title: 'Trip with friends', description: 'Two-day plan', category: 'Du lịch', location: 'Hà Nội', province: 'Hà Nội', district: 'Quận Ba Đình', ward: 'Phường Ba Đình', startsAt: '2099-01-01T02:00:00.000Z', endsAt: '2099-01-02T11:00:00.000Z', estimatedCost: 100000, costNote: 'Gồm xe; ăn tự túc', minParticipants: 2, maxParticipants: 5, reservedSeats: 2, initialFriendIds: [users[1].id], participantPreferences: { minAge: 18, maxAge: 65 }, itinerary: [{ id: 'step-2', date: '2099-01-02', time: '10:00', title: 'Tham quan', place: 'Hà Nội', note: '' }, { id: 'step-1', date: '2099-01-01', time: '09:00', title: 'Tập trung', place: '', note: '' }], planLink: 'https://docs.google.com/spreadsheets/d/example', planAttachment: { name: 'trip.xls', base64: workbook.toString('base64') } }
  let activity, conversation
  await t.test('creation validates seats, age, actual friends and plan times', async () => {
    assert.equal((await req('/activities', 'POST', { ...draft, organizerType: 'business' })).status, 403)
    assert.equal((await req('/activities', 'POST', { ...draft, maxParticipants: 3 })).status, 409)
    assert.equal((await req('/activities', 'POST', { ...draft, initialFriendIds: [users[3].id] })).status, 403)
    assert.equal((await req('/activities', 'POST', { ...draft, initialFriendIds: [users[4].id] })).status, 400)
    assert.equal((await req('/activities', 'POST', { ...draft, itinerary: [{ ...draft.itinerary[0], date: '2099-01-03' }] })).status, 400)
    assert.equal((await req('/activities', 'POST', { ...draft, planLink: 'http://127.0.0.1/private' })).status, 400)
    assert.equal((await req('/activities', 'POST', { ...draft, planAttachment: { name: 'bad.xlsx', base64: Buffer.from('<script>bad</script>').toString('base64') } })).status, 400)
    const created = await req('/activities', 'POST', draft)
    assert.equal(created.status, 201); activity = created.body.activity
    assert.equal(activity.memberCount, 4); assert.equal(activity.reservedSeats, 2); assert.equal(activity.itinerary[0].id, 'step-1')
    assert.equal(activity.planFile.name, 'trip.xls'); assert.equal(activity.planFileData, undefined); assert.equal(activity.initialFriendIds, undefined)
    assert.equal((await req('/activities/' + activity.id + '/members', 'GET', undefined, 1)).body.total, 2)
    assert.equal((await req('/activities/' + activity.id + '/join-requests', 'POST', {}, 4)).status, 403)
    assert.equal((await req('/activities/' + activity.id, 'PATCH', { organizerType: 'business' })).status, 403)
    const range = await req('/activities?minAge=66&maxAge=80', 'GET', undefined, 3); assert.ok(!range.body.items.some(row => row.id === activity.id))
  })
  await t.test('schedule confirmation is host-only, versioned, persisted and reset by schedule edits', async () => {
    const path = '/activities/' + activity.id + '/confirm-schedule'
    assert.equal((await req(path, 'POST', { version: activity.version }, 1)).status, 403)
    assert.equal((await req(path, 'POST', { version: activity.version - 1 })).status, 409)
    assert.equal((await req(path, 'POST', { version: activity.version, status: 'completed' })).status, 400)
    const confirmed = await req(path, 'POST', { version: activity.version })
    assert.equal(confirmed.status, 200); activity = confirmed.body.activity
    assert.ok(activity.scheduleConfirmedAt); assert.equal(activity.scheduleConfirmedBy, users[0].id)
    const repeated = await req(path, 'POST', { version: activity.version })
    assert.equal(repeated.status, 200); assert.equal(repeated.body.activity.version, activity.version)
    const moved = await req('/activities/' + activity.id, 'PATCH', { meetingPoint: 'Cổng phía đông', category: 'Cầu lông' })
    assert.equal(moved.status, 200); activity = moved.body.activity; assert.equal(activity.scheduleConfirmedAt, null)
    const updated = await req(path, 'POST', { version: activity.version })
    assert.equal(updated.status, 200); activity = updated.body.activity
    assert.equal((await req('/activities/' + activity.id, 'GET', undefined, 1)).body.activity.scheduleConfirmedAt, activity.scheduleConfirmedAt)
  })
  await t.test('files download as authenticated attachments, not active content or public JSON', async () => {
    const path = base + '/api/activities/' + activity.id + '/plan-file?version=' + activity.planFile.id
    assert.equal((await fetch(path)).status, 401)
    const response = await fetch(path, { headers: { Authorization: 'Bearer ' + tokens[1] } })
    assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /^attachment/); assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), workbook)
    assert.equal((await req('/activities/' + activity.id)).body.activity.planFileData, undefined)
  })
  await t.test('reserved places convert atomically to account membership and unlock existing early chat', async () => {
    const opened = await req('/conversations', 'POST', { type: 'group', activityId: activity.id })
    assert.equal(opened.status, 200); conversation = opened.body.conversation
    assert.equal(conversation.hostId, users[0].id); assert.equal(conversation.memberCount, activity.memberCount)
    assert.equal(conversation.scheduleConfirmedAt, activity.scheduleConfirmedAt)
    assert.equal(conversation.activityStatus, 'published')
    assert.equal((await req('/conversations/' + conversation.id + '/messages', 'GET', undefined, 2)).status, 403)
    assert.equal((await req('/activities/' + activity.id + '/members/friends', 'POST', { friendIds: [users[2].id] }, 1)).status, 403)
    const added = await req('/activities/' + activity.id + '/members/friends', 'POST', { friendIds: [users[2].id], useReservedSeats: true })
    assert.equal(added.status, 200); activity = added.body.activity; assert.equal(activity.memberCount, 4); assert.equal(activity.reservedSeats, 1)
    const repeat = await req('/activities/' + activity.id + '/members/friends', 'POST', { friendIds: [users[2].id] })
    assert.equal(repeat.body.activity.memberCount, 4); assert.equal(repeat.body.activity.reservedSeats, 1)
    const sent = await req('/conversations/' + conversation.id + '/messages', 'POST', { text: 'Lên kế hoạch trước chuyến đi', clientMessageId: 'trip-message' }, 2)
    assert.equal(sent.status, 200)
    assert.equal((await req('/conversations/' + conversation.id + '/messages', 'GET', undefined, 1)).body.items[0].text, 'Lên kế hoạch trước chuyến đi')
    assert.equal((await req('/conversations/' + conversation.id + '/messages', 'GET', undefined, 3)).status, 403)
    const otherChat = await req('/conversations', 'POST', { type: 'direct', userId: users[1].id })
    await req('/conversations/' + conversation.id + '/messages', 'POST', { text: 'Tin mới nhất trong nhóm', clientMessageId: 'latest-group-message' })
    const inbox = await req('/conversations')
    assert.equal(inbox.body.items[0].id, conversation.id)
    assert.ok(inbox.body.items.some(item => item.id === otherChat.body.conversation.id))
    const reduced = await req('/activities/' + activity.id, 'PATCH', { reservedSeats: 0, maxParticipants: 3 })
    assert.equal(reduced.status, 200); activity = reduced.body.activity; assert.equal(activity.memberCount, 3)
    await becomeFriends(3)
    assert.equal((await req('/activities/' + activity.id + '/members/friends', 'POST', { friendIds: [users[3].id], useReservedSeats: false })).status, 409)
  })
  await t.test('host-only plan editing uses versions, preserves Excel and revokes chat on member removal', async () => {
    const path = '/activities/' + activity.id + '/plan'
    assert.equal((await req(path, 'PATCH', { version: activity.version, planLink: '' }, 1)).status, 403)
    const changed = await req(path, 'PATCH', { version: activity.version, planLink: 'https://example.com/updated' })
    assert.equal(changed.status, 200); assert.equal(changed.body.activity.planFile.id, activity.planFile.id)
    assert.equal((await req(path, 'PATCH', { version: activity.version, planLink: '' })).status, 409)
    activity = changed.body.activity
    const removed = await req(path, 'PATCH', { version: activity.version, planAttachment: null })
    assert.equal(removed.status, 200); assert.equal(removed.body.activity.planFile, null)
    assert.equal((await req('/activities/' + activity.id + '/plan-file')).status, 404)
    assert.equal((await req('/activities/' + activity.id + '/members/' + users[2].id, 'DELETE')).status, 204)
    assert.equal((await req('/conversations/' + conversation.id + '/messages', 'GET', undefined, 2)).status, 403)
    assert.equal((await req('/activities/' + activity.id + '/start', 'POST', {})).status, 200)
    activity = (await req('/activities/' + activity.id)).body.activity
    assert.equal((await req(path, 'PATCH', { version: activity.version, planLink: '' })).status, 200)
    assert.equal((await req('/activities/' + activity.id + '/complete', 'POST', {})).status, 200)
    activity = (await req('/activities/' + activity.id)).body.activity
    assert.equal((await req(path, 'PATCH', { version: activity.version, planLink: '' })).status, 409)
    const direct = await req('/conversations', 'POST', { type: 'direct', userId: users[1].id })
    assert.equal(direct.status, 200)
    await req('/friends/' + users[1].id, 'DELETE')
    assert.ok(!(await req('/friends')).body.items.some(person => person.id === users[1].id))
  })
})
