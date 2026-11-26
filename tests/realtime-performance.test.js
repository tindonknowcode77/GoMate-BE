import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, ObjectId } from 'mongodb'
import { io as connect } from 'socket.io-client'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { initializeDatabase } from '../src/database/mongo.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { createChatRepository } from '../src/modules/chat/repository.js'
import { createBusinessAudience } from '../src/common/business-audience.js'
import { createCommunityRepository } from '../src/modules/community/repository.js'
import { attachChatSockets } from '../src/modules/chat/socket.js'
import { hashToken, newToken } from '../src/modules/auth/token.js'

function event(socket, name, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, receive); reject(new Error(`Missing ${name}`)) }, 5000)
    function receive(value) { if (predicate(value)) { clearTimeout(timer); socket.off(name, receive); resolve(value) } }
    socket.on(name, receive)
  })
}

test('chat idle reads do not rewrite events; unread and history stay correct; sockets enforce access', async t => {
  const mongo = await MongoMemoryServer.create()
  let realtime, socket, isolated;
  const client = new MongoClient(mongo.getUri(), { monitorCommands: true }); await client.connect();
  t.after(async () => { socket?.disconnect(); isolated?.disconnect(); if (realtime) await new Promise(resolve => realtime.close(resolve)); await client.close(); await mongo.stop(); });
  const db = client.db('realtime_test'); await initializeDatabase(db)
  const auth = createAuthRepository(db), chat = createChatRepository(db)
  const tokens = [newToken(), newToken(), newToken()]
  for (let index = 0; index < 3; index++) {
    await db.collection('users').insertOne({ id: `user-${index}`, email: `u${index}@example.com`, email_verified: true, name: `User ${index}` })
    await auth.createSession({ userId: `user-${index}`, tokenHash: hashToken(tokens[index]), expiresAt: new Date(Date.now() + 60000) })
  }
  await db.collection('activities').insertOne({ id: 'activity', hostId: 'user-0', status: 'published', title: 'Group', updates: Array.from({ length: 100 }, (_, i) => ({ id: `event-${i}`, type: 'note', actorId: 'user-0', text: 'note', createdAt: new Date() })) })
  const group = await chat.create('user-0', { type: 'group', activityId: 'activity' })
  const commands = [], record = event => commands.push(event.commandName)
  client.on('commandStarted', record)
  const session = await auth.findSession(hashToken(tokens[0]))
  client.off('commandStarted', record)
  assert.equal(session.user.id, 'user-0')
  assert.deepEqual(commands, ['aggregate'], 'each authenticated request should use one DB round trip')
  commands.length = 0
  client.on('commandStarted', record)
  await chat.snapshot(group.id, 'user-0')
  client.off('commandStarted', record)
  assert.equal(commands.filter(name => ['update', 'insert', 'delete', 'bulkWrite'].includes(name)).length, 0)
  assert.ok(commands.length < 30, `Idle snapshot used ${commands.length} commands`)
  t.diagnostic(`Idle snapshot with 100 existing events: ${commands.length} DB commands, zero writes`)

  const direct = await chat.create('user-0', { type: 'direct', userId: 'user-1' })
  const missed = Array.from({ length: 125 }, (_, index) => ({ _id: new ObjectId(Math.floor((Date.now() - 86400000) / 1000).toString(16) + index.toString(16).padStart(16, '0')), conversationId: direct.id, senderId: 'user-1', clientMessageId: `missed-${index}`, text: 'offline', createdAt: new Date() }))
  await db.collection('chat_messages').insertMany(missed)
  const page1 = await chat.history(direct.id, 'user-0', { after: missed[0]._id.toHexString(), limit: 100 })
  const page2 = await chat.history(direct.id, 'user-0', { after: page1.nextCursor, limit: 100 })
  assert.equal(page1.hasMore, true); assert.equal(page2.hasMore, false)
  assert.deepEqual([...page1.items, ...page2.items].map(row => row.id), missed.slice(1).map(row => row._id.toHexString()))
  assert.equal(await chat.unreadCount('user-0'), 125)
  assert.equal((await chat.list('user-0', 1, 20, { q: 'offline' })).total, 1)
  assert.equal((await chat.list('user-0', 1, 20, { q: 'User 1', type: 'direct' })).total, 1)
  assert.equal((await chat.list('user-0', 1, 20, { q: '.*' })).total, 0, 'search is literal, not executable regex')
  assert.equal((await chat.list('user-0', 1, 20, { unread: true })).total, 1)
  assert.equal((await chat.list('user-0', 1, 20, { type: 'group' })).total, 1)
  await chat.markRead(direct.id, 'user-0', missed.at(-1)._id.toHexString())
  assert.equal(await chat.unreadCount('user-0'), 0)
  assert.equal((await chat.list('user-0', 1, 20, { unread: true })).total, 0)
  commands.length = 0; client.on('commandStarted', record)
  await chat.markRead(direct.id, 'user-0', missed.at(-1)._id.toHexString(), false)
  client.off('commandStarted', record)
  assert.equal(commands.filter(name => name === 'aggregate').length, 0, 'minimal read receipts must not rebuild message summaries')
  assert.ok(commands.length <= 6, `Minimal read receipt used ${commands.length} commands`)
  t.diagnostic(`Authentication: one DB command; minimal read receipt: ${commands.length} DB commands`)

  const config = readConfig({}), server = createServer(createApp(config, { authRepository: auth, chatRepository: chat }))
  realtime = attachChatSockets(server, config, chat, auth, { reconcileMs: 100 })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}`
  const headers = { Authorization: `Bearer ${tokens[0]}`, 'Accept-Encoding': 'gzip' }
  const history = await fetch(`${url}/api/conversations/${direct.id}/messages?after=${missed[0]._id.toHexString()}&limit=100`, { headers })
  assert.equal(history.headers.get('content-encoding'), 'gzip')
  assert.equal((await history.json()).items.length, 100)
  assert.equal((await fetch(`${url}/api/conversations?type=invalid`, { headers })).status, 400)
  assert.equal((await fetch(`${url}/api/conversations/${direct.id}/messages?before=${missed[0]._id.toHexString()}&after=${missed[1]._id.toHexString()}`, { headers })).status, 400)
  socket = connect(url, { transports: ['websocket'], auth: { token: tokens[0] }, autoConnect: false }); t.after(() => socket.disconnect())
  const ready = event(socket, 'connect'); socket.connect(); await ready
  const initial = event(socket, 'conversation.updated', row => row.id === direct.id)
  socket.emit('conversation.subscribe', direct.id); await initial
  const incoming = event(socket, 'conversation.updated', row => row.lastMessage?.clientMessageId === 'live')
  await chat.send(direct.id, 'user-1', { text: 'Live message', clientMessageId: 'live' })
  assert.equal((await incoming).unreadCount, 1)
  const unauthorized = await new Promise(resolve => socket.emit('conversation.subscribe', 'missing', resolve))
  assert.equal(unauthorized.ok, false)
  isolated = connect(url, { transports: ['websocket'], auth: { token: tokens[2] }, autoConnect: false }); t.after(() => isolated.disconnect())
  const isolatedReady = event(isolated, 'connect'); isolated.connect(); await isolatedReady
  assert.equal((await new Promise(resolve => isolated.emit('conversation.subscribe', direct.id, resolve))).ok, false)
  const revoked = event(socket, 'conversation.revoked', row => row.id === direct.id)
  await db.collection('user_blocks').insertOne({ ownerId: 'user-1', targetId: 'user-0' })
  chat.events.emit('activity'); assert.equal((await revoked).status, 403)
  const loggedOut = event(socket, 'session.revoked')
  await db.collection('auth_sessions').deleteOne({ token_hash: hashToken(tokens[0]) }); await loggedOut
})

test('withdrawn audience assignment selects an available replacement and batched reputations match single results', async t => {
  const mongo = await MongoMemoryServer.create()
  const client = new MongoClient(mongo.getUri()); await client.connect(); t.after(async () => { await client.close(); await mongo.stop() })
  const db = client.db('audience_test')
  await db.collection('business_posts').insertOne({ id: 'post', ownerId: 'business', status: 'approved', groups: [{ activityId: 'old', state: 'withdrawn' }, { activityId: 'new' }] })
  await db.collection('activities').insertMany([{ id: 'old', businessPostId: 'post', status: 'cancelled', businessRevoked: true }, { id: 'new', businessPostId: 'post', status: 'published' }, { id: 'completed', hostId: 'host', status: 'completed', attendance: [{ userId: 'host', status: 'late' }] }])
  await db.collection('business_audiences').insertOne({ userId: 'viewer', postId: 'post', activityId: 'old' })
  const scope = await createBusinessAudience(db).scope('viewer')
  const visible = await db.collection('activities').find({ $and: [scope, { status: 'published' }] }).toArray()
  assert.deepEqual(visible.map(row => row.id), ['new'])
  await db.collection('activity_ratings').insertMany([{ targetUserId: 'host', score: 4 }, { targetUserId: 'host', score: 2 }])
  const community = createCommunityRepository(db), batch = await community.reputations(['host', 'empty'])
  for (const id of ['host', 'empty']) assert.deepEqual(batch.get(id), await community.reputation(id))
})
