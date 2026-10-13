import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { createActivityRepository } from '../src/modules/activities/repository.js'
import { createChatRepository } from '../src/modules/chat/repository.js'
import { hashToken, newToken } from '../src/modules/auth/token.js'

test('chat persistence, isolation, idempotency, read state and SSE revocation', async t => {
  const mongo = await MongoMemoryServer.create(); t.after(() => mongo.stop())
  const client = createClient(readConfig({ MONGODB_URI: mongo.getUri('chat_test') }))
  await client.connect(); t.after(() => client.close())
  const db = client.db(); await initializeDatabase(db)
  const authRepository = createAuthRepository(db), activities = createActivityRepository(db), chatRepository = createChatRepository(db)
  const users = [], tokens = []
  for (let i = 0; i < 3; i++) {
    const user = await authRepository.createUser({ name: `User ${i}`, email: `chat${i}@example.com`, passwordHash: 'unused' })
    await db.collection('users').updateOne({ id: user.id }, { $set: { email_verified: true } })
    users.push(user); tokens.push(newToken())
    await authRepository.createSession({ userId: user.id, tokenHash: hashToken(tokens[i]), expiresAt: new Date(Date.now() + 120000) })
  }
  const server = createApp(readConfig({}), { authRepository, activityRepository: activities, chatRepository, chatOptions: { streamIntervalMs: 30 } }).listen(0, '127.0.0.1')
  await once(server, 'listening'); t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const base = `http://127.0.0.1:${server.address().port}/api/conversations`
  const req = async (user, path = '', method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(user >= 0 ? { Authorization: `Bearer ${tokens[user]}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, body: await response.json() }
  }
  assert.equal((await req(-1)).status, 401)
  for (const body of [{ type: 'other' }, { type: 'direct', userId: users[0].id }, { type: 'direct', userId: users[1].id, senderId: users[2].id }]) assert.equal((await req(0, '', 'POST', body)).status, 400)
  assert.equal((await req(0, '', 'POST', { type: 'direct', userId: 'missing' })).status, 404)
  const direct = await Promise.all([req(0, '', 'POST', { type: 'direct', userId: users[1].id }), req(1, '', 'POST', { type: 'direct', userId: users[0].id })])
  assert.equal(direct[0].status, 200); assert.equal(direct[0].body.conversation.id, direct[1].body.conversation.id)
  const id = direct[0].body.conversation.id
  assert.equal((await req(2)).body.total, 0)
  assert.equal((await req(2, `/${id}/messages`)).status, 403)
  assert.equal((await req(2, `/${id}/messages`, 'POST', { text: 'hack', clientMessageId: 'hack' })).status, 403)
  assert.equal((await req(0, '?page=0')).status, 400)
  assert.equal((await req(0, `/${id}/messages?before=invalid`)).status, 400)
  assert.equal((await req(0, `/${id}/messages`, 'POST', { text: ' ', clientMessageId: 'a' })).status, 400)
  assert.equal((await req(0, `/${id}/messages`, 'POST', { text: 'x'.repeat(4001), clientMessageId: 'long' })).status, 400)
  assert.equal((await req(0, `/${id}/messages?limit=101`)).status, 400)
  assert.equal((await req(0, `/${id}/read`, 'PATCH', { messageId: 'bad' })).status, 400)
  const send = (key, text = key) => req(0, `/${id}/messages`, 'POST', { text, clientMessageId: key })
  const duplicate = await Promise.all([send('first'), send('first')])
  const first = duplicate[0].body.message
  assert.equal(first.id, duplicate[1].body.message.id)
  assert.equal(first.senderId, users[0].id)
  assert.equal((await send('first', 'changed')).status, 409)
  const second = (await send('second')).body.message
  assert.equal((await req(1)).body.items[0].unreadCount, 2)
  assert.equal((await req(0)).body.items[0].unreadCount, 0)
  const page = (await req(1, `/${id}/messages?limit=1`)).body
  assert.equal(page.items[0].id, second.id); assert.equal(page.hasMore, true)
  assert.equal((await req(1, `/${id}/messages?before=${page.nextCursor}&limit=1`)).body.items[0].id, first.id)
  await req(1, `/${id}/read`, 'PATCH', { messageId: second.id })
  await req(1, `/${id}/read`, 'PATCH', { messageId: first.id })
  const read = (await req(1)).body.items[0]
  assert.equal(read.unreadCount, 0); assert.equal(read.lastReadMessageId, second.id)
  assert.equal((await req(2, `/${id}/read`, 'PATCH', { messageId: second.id })).status, 403)

  const activity = await activities.create({ title: 'Group', startsAt: new Date('2099-01-01'), maxParticipants: 3 }, users[0])
  assert.equal((await req(1, '', 'POST', { type: 'group', activityId: activity.id })).status, 403)
  const join = await activities.submitJoinRequest(activity.id, users[1])
  await activities.changeJoinRequest(activity.id, { hostId: users[0].id, requestId: join.id, status: 'approved' })
  const group = (await req(1, '', 'POST', { type: 'group', activityId: activity.id })).body.conversation.id
  const listPage = (await req(1, '?limit=1')).body
  assert.equal(listPage.total, 2); assert.equal(listPage.hasMore, true)
  assert.equal((await req(1, '?limit=1&page=2')).body.hasMore, false)
  assert.equal((await req(1, '?limit=1&page=3')).body.items.length, 0)
  assert.equal((await req(0, '', 'POST', { type: 'group', activityId: activity.id })).body.conversation.id, group)
  assert.equal((await req(1, `/${group}/read`, 'PATCH', { messageId: first.id })).status, 404)
  async function stream(user, conversation) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)
    const response = await fetch(`${base}/${conversation}/events`, { headers: { Authorization: `Bearer ${tokens[user]}` }, signal: controller.signal })
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/)
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = ''
    const close = () => { clearTimeout(timeout); controller.abort() }; t.after(close)
    return { close, async next(event, predicate = () => true) {
      for (;;) {
        let index
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2)
          if (frame.startsWith(`event: ${event}\n`)) {
            const data = JSON.parse(frame.split('\ndata: ')[1]); if (predicate(data)) return data
          }
        }
        const chunk = await reader.read(); if (chunk.done) throw new Error('Stream ended before expected event')
        buffer += decoder.decode(chunk.value, { stream: true })
      }
    } }
  }
  const events = await stream(1, group)
  await events.next('conversation.updated')
  const groupMessage = (await req(0, `/${group}/messages`, 'POST', { text: 'Hello group', clientMessageId: 'group-first' })).body.message
  const notification = await events.next('conversation.updated', data => data.lastMessage?.id === groupMessage.id)
  assert.equal(notification.unreadCount, 1)
  await req(1, `/${group}/read`, 'PATCH', { messageId: groupMessage.id })
  assert.equal((await events.next('conversation.updated', data => data.lastReadMessageId === groupMessage.id)).unreadCount, 0)
  // A fresh repository sees persistent state; stream initial snapshots support reconnect.
  assert.equal((await createChatRepository(db).snapshot(group, users[1].id)).lastMessage.id, groupMessage.id)
  await activities.removeMember(activity.id, users[1].id, users[0].id, true)
  assert.equal((await events.next('access-revoked')).status, 403); events.close()
  assert.equal((await req(1, `/${group}/messages`)).status, 403)
  assert.equal((await req(1, `/${group}/messages`, 'POST', { text: 'No access', clientMessageId: 'revoked' })).status, 403)
  assert.equal((await req(1, `/${group}/events`)).status, 403)
  assert.equal((await req(1)).body.total, 1)
  await activities.remove(await activities.get(activity.id))
  assert.equal((await req(0, `/${group}/messages`)).status, 403)
  const authStream = await stream(1, id)
  await authStream.next('conversation.updated')
  await db.collection('auth_sessions').deleteOne({ token_hash: hashToken(tokens[1]) })
  assert.equal((await authStream.next('access-revoked')).status, 401); authStream.close()
})
