import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { newToken, hashToken } from '../src/modules/auth/token.js'

test('admin HTTP validation rejects bypasses without writes and handles concurrent/stale mutations', async t => {
  const mongo = await MongoMemoryServer.create(); t.after(() => mongo.stop())
  const client = createClient(readConfig({ MONGODB_URI: mongo.getUri('admin_validation') })); await client.connect(); t.after(() => client.close())
  const db = client.db(); await initializeDatabase(db); const auth = createAuthRepository(db)
  const admin = await auth.createUser({ name: 'Admin', email: 'admin@example.com', passwordHash: 'unused' })
  const owner = await auth.createUser({ name: 'Owner', email: 'owner@example.com', passwordHash: 'unused' })
  await db.collection('users').updateOne({ id: admin.id }, { $set: { role: 'admin', email_verified: true } })
  await db.collection('business_applications').insertOne({ id: 'business', ownerId: owner.id, company: 'Business', status: 'approved', version: 1 })
  await db.collection('business_posts').insertOne({ id: 'post', ownerId: owner.id, status: 'pending', title: 'Original', version: 1 })
  const token = newToken(); await auth.createSession({ userId: admin.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 600000) })
  const server = createApp(readConfig({}), { authRepository: auth }).listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)))
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/portal` + path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  }
  for (const query of ['page=1&page=2', 'page=1e2', 'page=', 'q=x&q=y', 'status=deleted', 'status=invalid', 'sort=name', 'q[$ne]=x']) assert.equal((await request('/admin/posts?' + query)).status, 400, query)
  const userPath = '/admin/users/' + owner.id
  const invalidWrites = [
    ['/admin/users', 'POST', { name: 'Valid', email: 'spaces@example.com', password: '      ' }],
    [userPath, 'PUT', null], [userPath, 'PUT', []], [userPath, 'PUT', {}],
    [userPath, 'PUT', { name: 'A', adminVersion: 0 }], [userPath, 'PUT', { name: '  ', adminVersion: 0 }],
    [userPath, 'PUT', { name: 'Valid', adminVersion: '0' }], [userPath, 'PUT', { name: 'Valid', adminVersion: Number.MAX_SAFE_INTEGER + 1 }],
    [userPath, 'PUT', { name: 'Valid', role: 'admin', adminVersion: 0 }],
    ['/admin/posts/post', 'PUT', { version: 1, post: { title: 'Bypass', copy: 'Content', border: 'Solid', premium: false } }],
    ['/admin/posts/post', 'PUT', { version: 1, adminVersion: 0, post: null }],
    ['/admin/posts', 'POST', { ownerId: owner.id, post: { title: 'Invalid', copy: 'Content', border: 'Solid', premium: false, discountPercent: null } }],
    ['/admin/businesses', 'POST', { ownerId: owner.id, application: null }],
    ['/admin/tickets', 'POST', { ownerId: { $ne: null }, subject: 'Title', message: 'Body' }],
    ['/admin/reports', 'POST', { activityId: 'bad/id', reason: 'Reason', detail: '' }],
  ]
  for (const [path, method, body] of invalidWrites) assert.equal((await request(path, method, body)).status, 400, JSON.stringify(body))
  assert.equal(await db.collection('users').countDocuments(), 2)
  assert.equal((await db.collection('users').findOne({ id: owner.id })).name, 'Owner')
  assert.equal((await db.collection('business_posts').findOne({ id: 'post' })).version, 1)
  assert.equal(await db.collection('support_tickets').countDocuments(), 0)
  assert.equal((await request('/admin/users', 'POST', { name: 'x'.repeat(33000) })).status, 413)
  const concurrent = await Promise.all(['First', 'Second'].map(name => request(userPath, 'PUT', { name, adminVersion: 0 })))
  assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409])
  assert.equal((await db.collection('users').findOne({ id: owner.id })).adminVersion, 1)
  assert.equal((await request('/users/' + owner.id + '/subscription', 'PATCH', { plan: 'plus', status: 'active' })).status, 200)
  assert.equal((await request(userPath, 'PUT', { name: 'Stale after subscription', adminVersion: 1 })).status, 409)
  const ticket = await request('/admin/tickets', 'POST', { ownerId: ' ' + owner.id + ' ', subject: ' Trimmed ', message: 'Body' })
  assert.equal(ticket.status, 201); assert.equal(ticket.body.ownerId, owner.id); assert.equal(ticket.body.subject, 'Trimmed')
  assert.equal((await request('/admin/tickets/' + ticket.body.id, 'PUT', { adminVersion: 0, subject: 'Title', status: 'invalid' })).status, 400)
  const post = { title: 'Validated', copy: 'Content', border: 'Solid', premium: false, offer: '   ' }
  assert.equal((await request('/admin/posts/post', 'PUT', { version: 1, adminVersion: 0, post })).status, 200)
  assert.equal((await request('/admin/posts/post', 'PUT', { version: 1, adminVersion: 0, post })).status, 409)
})
