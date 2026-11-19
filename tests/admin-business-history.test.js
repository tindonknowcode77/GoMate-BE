import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { ObjectId } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { newToken, hashToken } from '../src/modules/auth/token.js'

test('Admin business reports and investigation preserve tenant scope, history and chat read state', async t => {
  const mongo = await MongoMemoryServer.create(); t.after(() => mongo.stop())
  const client = createClient(readConfig({ MONGODB_URI: mongo.getUri('admin_business_history') })); await client.connect(); t.after(() => client.close())
  const db = client.db(); await initializeDatabase(db)
  const auth = createAuthRepository(db), users = [], tokens = []
  for (const [index, name] of ['Admin', 'Business A', 'Business B', 'Member', 'Staff'].entries()) {
    const user = await auth.createUser({ name, email: `inspection-${index}@example.com`, passwordHash: 'hidden' }); users.push(user)
    await db.collection('users').updateOne({ id: user.id }, { $set: { role: index === 0 ? 'admin' : 'user', email_verified: true } })
    const token = newToken(); tokens.push(token); await auth.createSession({ userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 600000) })
  }
  const date = new Date('2026-11-18T01:00Z'), old = new Date('2026-10-18T01:00Z')
  await db.collection('business_applications').insertMany([
    { id: 'business-a', ownerId: users[1].id, company: 'Alpha Business', status: 'approved', document: { data: 'private' } },
    { id: 'business-b', ownerId: users[2].id, company: 'Beta Business', status: 'deleted', deletedAt: date },
  ])
  await db.collection('business_posts').insertMany(Array.from({ length: 23 }, (_, index) => ({ id: 'a-post-' + index, ownerId: users[1].id, title: 'Alpha Post ' + index, status: index ? 'approved' : 'deleted', createdAt: date, lifecycleTasks: [{ private: true }], history: [{ type: 'approved', createdAt: date }] })))
  await db.collection('business_posts').insertOne({ id: 'b-post', ownerId: users[2].id, title: 'Beta Post', status: 'approved', createdAt: date })
  await db.collection('activities').insertMany([
    { id: 'a-activity', hostId: users[1].id, organizerType: 'business', businessPostId: 'a-post-0', title: 'Alpha Activity', status: 'completed', location: 'Private cafe address', province: 'TP.HCM', district: 'Quận 1', memberCount: 5, createdAt: date, completedAt: date },
    { id: 'a-old', hostId: users[1].id, organizerType: 'business', title: 'Deleted Activity', status: 'deleted', location: 'Private venue', province: 'TP.HCM', district: 'Quận 1', memberCount: 100, createdAt: old },
    { id: 'a-personal', hostId: users[1].id, organizerType: 'personal', title: 'Personal Group', status: 'published' },
    { id: 'b-activity', hostId: users[2].id, organizerType: 'business', title: 'Beta Activity', status: 'published', location: 'Other specific venue', province: 'Ho Chi Minh City', district: 'Quận 1', memberCount: 3, createdAt: date },
    { id: 'unknown-region', title: 'Legacy', status: 'published', location: 'A specific cafe', memberCount: 99 },
  ])
  await db.collection('finance_escrows').insertMany([
    { _id: 'a-ledger', ownerId: users[1].id, lots: [
      { amount: 50000, state: 'held', verifiedAt: date },
      { amount: 20000, state: 'refunded', verifiedAt: old, refund: { status: 'completed', amount: 20000, completedAt: date } },
    ], payouts: [{ status: 'completed', amount: 45000, feeAmount: 5000, processedAt: date }, { status: 'processing', amount: 9000 }] },
    { _id: 'b-ledger', ownerId: users[2].id, lots: [{ amount: 999999, state: 'held', verifiedAt: date }], payouts: [{ status: 'completed', amount: 90000, feeAmount: 10000, processedAt: date }] },
  ])
  await db.collection('conversations').insertMany([
    { id: 'a-group', type: 'group', key: 'activity:a-activity', activityId: 'a-activity', createdAt: date },
    { id: 'a-deleted-group', type: 'group', key: 'activity:a-old', activityId: 'a-old', createdAt: old },
    { id: 'personal-group', type: 'group', key: 'activity:a-personal', activityId: 'a-personal', createdAt: date },
    { id: 'b-group', type: 'group', key: 'activity:b-activity', activityId: 'b-activity', createdAt: date },
    { id: 'a-direct', type: 'direct', key: 'a-direct', participantIds: [users[1].id, users[3].id], createdAt: date },
    { id: 'staff-private', type: 'direct', key: 'staff-private', participantIds: [users[4].id, users[3].id], createdAt: date },
    { id: 'member-private', type: 'direct', key: 'member-private', participantIds: [users[2].id, users[3].id], createdAt: date },
  ])
  const messageIds = Array.from({ length: 3 }, () => new ObjectId())
  await db.collection('chat_messages').insertMany(messageIds.map((_id, index) => ({ _id, conversationId: 'a-group', senderId: users[1].id, senderName: users[1].name, text: index === 1 ? 'Contact https://example.com .*' : 'Message ' + index, clientMessageId: 'message-' + index, createdAt: date })))
  await db.collection('chat_reads').insertOne({ conversationId: 'a-group', userId: users[3].id, messageId: messageIds[0] })
  const server = createApp(readConfig({}), { authRepository: auth }).listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const request = async (path, who = 0, method = 'GET') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/portal/admin${path}`, { method, headers: who === null ? {} : { Authorization: 'Bearer ' + tokens[who] } })
    return { status: response.status, body: await response.json() }
  }
  const ok = (result, status = 200) => { assert.equal(result.status, status, JSON.stringify(result.body)); return result.body }
  await t.test('all inspection paths reject unauthenticated users, business owners and ordinary members', async () => {
    for (const path of ['/business-directory', '/analytics/revenue?businessId=business-a', '/businesses/business-a/history/posts', '/businesses/business-a/history/activities', '/businesses/business-a/history/conversations', '/businesses/business-a/conversations/a-group/messages']) {
      ok(await request(path, null), 401); ok(await request(path, 1), 403); ok(await request(path, 3), 403)
    }
    for (const path of ['/business-directory?page=0', '/business-directory?q=x&q=y', '/businesses/business-a/history/posts?limit=1000', '/businesses/business-a/conversations/a-group/messages?before=invalid', '/analytics/revenue?businessId=business-a&businessId=business-b']) ok(await request(path), 400)
    ok(await request('/analytics/revenue?businessId=missing'), 404)
  })
  await t.test('directory/search and revenue include archived businesses without leaking or mixing balances', async () => {
    const directory = ok(await request('/business-directory')); assert.equal(directory.total, 2); assert.equal(directory.items[0].document, undefined)
    assert.equal(ok(await request('/business-directory?q=Alpha')).items[0].id, 'business-a'); assert.equal(ok(await request('/business-directory?q=.*')).total, 0)
    const finance = ok(await request('/analytics/revenue?type=monthly&year=2026&month=11&businessId=business-a'))
    assert.equal(finance.totalRevenue, 5000); assert.equal(finance.settledPayouts, 45000); assert.equal(finance.transactions, 1)
    assert.deepEqual(finance.businessSummary, { receivedDeposits: 50000, refundedDeposits: 20000, currentHeld: 50000, currentPendingPayouts: 9000 })
    assert.equal(ok(await request('/analytics/revenue?type=monthly&year=2026&month=11&businessId=business-b')).totalRevenue, 10000)
    assert.equal(ok(await request('/analytics/revenue?type=monthly&year=2026&month=11')).totalRevenue, 15000)
  })
  await t.test('region rankings combine different venues and city aliases, omit venue-only legacy data', async () => {
    const value = ok(await request('/analytics/performance'))
    assert.deepEqual(value.topCities, [{ name: 'TP. Hồ Chí Minh', area: '', activityCount: 2, participantCount: 8 }])
    assert.deepEqual(value.topDistricts, [{ name: 'Quận 1', area: 'TP. Hồ Chí Minh', activityCount: 2, participantCount: 8 }])
    assert.ok(!JSON.stringify(value.topCities).includes('cafe'))
  })
  await t.test('history retains deleted entries, is paginated and excludes unrelated activities', async () => {
    const posts = ok(await request('/businesses/business-a/history/posts')); assert.equal(posts.total, 23); assert.equal(posts.items.length, 20); assert.equal(posts.hasMore, true)
    assert.equal(posts.items[0].lifecycleTasks, undefined)
    const next = ok(await request('/businesses/business-a/history/posts?page=2')); assert.equal(next.items.length, 3); assert.equal(next.hasMore, false)
    assert.equal(new Set([...posts.items, ...next.items].map(row => row.id)).size, 23)
    assert.ok([...posts.items, ...next.items].some(row => row.status === 'deleted'))
    const activities = ok(await request('/businesses/business-a/history/activities')); assert.deepEqual(activities.items.map(row => row.id), ['a-activity', 'a-old'])
    assert.equal(ok(await request('/businesses/business-a/history/posts?q=Beta')).total, 0)
  })
  await t.test('conversation scope includes business groups and owner direct chat, excludes staff/private groups', async () => {
    const value = ok(await request('/businesses/business-a/history/conversations'))
    assert.deepEqual(value.items.map(row => row.id).sort(), ['a-deleted-group', 'a-direct', 'a-group'])
    const direct = value.items.find(row => row.id === 'a-direct'); assert.ok(direct.title.includes('Member'))
    assert.equal(direct.participants[0].email, undefined)
    for (const id of ['b-group', 'staff-private', 'member-private', 'personal-group']) ok(await request('/businesses/business-a/conversations/' + id + '/messages'), 404)
    const page = ok(await request('/businesses/business-a/conversations/a-group/messages?limit=2')); assert.equal(page.items.length, 2); assert.equal(page.hasMore, true)
    assert.equal(page.items[0].clientMessageId, undefined)
    const older = ok(await request('/businesses/business-a/conversations/a-group/messages?limit=2&before=' + page.nextCursor)); assert.equal(older.items.length, 1); assert.equal(older.items[0].id, messageIds[0].toHexString())
    const search = ok(await request('/businesses/business-a/conversations/a-group/messages?q=.*')); assert.equal(search.items.length, 1)
    assert.equal((await db.collection('chat_reads').findOne({ conversationId: 'a-group' })).messageId.toHexString(), messageIds[0].toHexString())
    assert.equal(await db.collection('conversations').countDocuments(), 7)
    const log = await db.collection('admin_business_access').findOne({ resource: 'messages', conversationId: 'a-group' }); assert.equal(log.actorId, users[0].id); assert.equal(log.businessId, 'business-a'); assert.equal(log.text, undefined)
  })
})
