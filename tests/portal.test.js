import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { newToken, hashToken } from '../src/modules/auth/token.js'

test('portal persists business, moderation, support and subscription flows with server-side authorization', async t => {
  const mongo = await MongoMemoryServer.create(); t.after(() => mongo.stop())
  const client = createClient(readConfig({ MONGODB_URI: mongo.getUri('portal') })); await client.connect(); t.after(() => client.close())
  const db = client.db(); await initializeDatabase(db)
  const auth = createAuthRepository(db), people = [], tokens = []
  for (const role of ['user', 'user', 'staff', 'admin']) {
    const user = await auth.createUser({ name: role, email: `${people.length}@example.com`, passwordHash: 'secret' }); people.push(user)
    await db.collection('users').updateOne({ id: user.id }, { $set: { role, email_verified: true } })
    const token = newToken(); tokens.push(token); await auth.createSession({ userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 600000) })
  }
  const server = createApp(readConfig({}), { authRepository: auth }).listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api/portal`
  const request = async (path, method = 'GET', body, who = 0) => {
    const response = await fetch(base + path, { method, headers: { Authorization: 'Bearer ' + tokens[who], 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  }
  const application = { company: 'Test Business', category: 'Events', website: 'https://example.com', document: { name: 'proof.pdf', mime: 'application/pdf', base64: Buffer.from('%PDF-1.4\nTest document').toString('base64') } }
  let applicationId, postId, ticketId
  await t.test('unprivileged accounts cannot enumerate or self-assign privileged fields', async () => {
    assert.equal((await request('/users')).status, 403)
    assert.equal((await request('/applications')).status, 403)
    assert.equal((await request('/applications', 'POST', { ...application, role: 'admin' })).status, 400)
    assert.equal((await request('/applications', 'POST', { ...application, document: { ...application.document, base64: 'bm90IHBkZg==' } })).status, 400)
    assert.equal((await request('/posts', 'POST', {})).status, 403)
  })
  await t.test('application document stays private and approval enables business privileges', async () => {
    const result = await request('/applications', 'POST', application); assert.equal(result.status, 201); applicationId = result.body.id
    assert.equal(result.body.document, undefined)
    assert.equal((await request('/applications', 'POST', application)).status, 409)
    assert.equal((await request('/me')).body.application.status, 'pending')
    assert.equal((await request(`/applications/${applicationId}/document`, 'GET', undefined, 1)).status, 403)
    const file = await fetch(base + `/applications/${applicationId}/document`, { headers: { Authorization: 'Bearer ' + tokens[3] } }); assert.equal(file.status, 200); assert.ok((await file.text()).startsWith('%PDF-'))
    assert.equal((await request(`/applications/${applicationId}`, 'PATCH', { status: 'approved' }, 2)).status, 200)
    assert.equal((await request(`/applications/${applicationId}`, 'PATCH', { status: 'approved' }, 3)).status, 409)
    assert.equal((await request(`/applications/${applicationId}`, 'PATCH', { status: 'rejected' }, 3)).status, 409)
    assert.equal((await request('/me')).body.role, 'business')
    assert.equal((await request('/me', 'GET', undefined, 1)).body.role, 'user')
  })
  await t.test('premium is enforced on server, posts are owned and only approved posts appear in feed', async () => {
    const post = { title: 'A real event', copy: 'A community invitation', premium: true, badge: 'New', discount: 'Free entry', border: 'Soft' }
    assert.equal((await request('/posts', 'POST', post)).status, 403)
    assert.equal((await request(`/users/${people[0].id}/subscription`, 'PATCH', { plan: 'plus', status: 'active' }, 2)).status, 403)
    assert.equal((await request(`/users/${people[0].id}/subscription`, 'PATCH', { plan: 'plus', status: 'active', role: 'admin' }, 3)).status, 400)
    assert.equal((await request(`/users/${people[0].id}/subscription`, 'PATCH', { plan: 'plus', status: 'active' }, 3)).status, 200)
    const result = await request('/posts', 'POST', post); assert.equal(result.status, 201); postId = result.body.id
    assert.equal((await request('/feed')).body.total, 0)
    assert.equal((await request(`/posts/${postId}`, 'PATCH', { status: 'approved' })).status, 403)
    assert.equal((await request(`/posts/${postId}`, 'PATCH', { status: 'approved', reviewNote: 'Reviewed' }, 2)).status, 200)
    assert.equal((await request('/feed')).body.items[0].id, postId)
    assert.equal((await request('/feed')).body.items[0].reviewedBy, undefined)
    assert.equal((await request(`/posts/${postId}`, 'PATCH', { status: 'rejected' }, 3)).status, 409)
    await request(`/users/${people[0].id}/subscription`, 'PATCH', { plan: 'plus', status: 'paused' }, 3)
    assert.equal((await request('/posts', 'POST', post)).status, 403)
  })
  await t.test('tickets persist and prevent cross-account reads or replies', async () => {
    const result = await request('/tickets', 'POST', { subject: 'Plan question', message: 'Please help' }); assert.equal(result.status, 201); ticketId = result.body.id
    assert.equal((await request('/tickets', 'GET', undefined, 1)).body.total, 0)
    assert.equal((await request(`/tickets/${ticketId}/replies`, 'POST', { message: 'Intrusion', status: 'closed' }, 1)).status, 404)
    assert.equal((await request(`/tickets/${ticketId}/replies`, 'POST', { message: 'Resolved', status: 'closed' }, 2)).status, 200)
    const saved = (await request('/tickets')).body.items[0]; assert.equal(saved.status, 'closed'); assert.equal(saved.messages.length, 2)
    assert.equal((await request(`/tickets/${ticketId}/replies`, 'POST', { message: 'Follow up', status: 'closed' })).body.status, 'open')
  })
  await t.test('metrics and user export contain real aggregates without password or token fields', async () => {
    assert.equal((await request('/metrics')).body.approvedPosts, 1)
    const staffMetrics = (await request('/metrics', 'GET', undefined, 2)).body
    assert.equal(staffMetrics.approvedPosts, 1)
    assert.equal(staffMetrics.pendingPosts, 0)
    assert.equal(staffMetrics.pendingBusinesses, await db.collection('business_applications').countDocuments({ status: 'pending' }))
    assert.equal(staffMetrics.openTickets, 1)
    assert.equal((await request('/metrics', 'GET', undefined, 3)).body.users, 4)
    const result = await request('/users', 'GET', undefined, 3); assert.equal(result.body.total, 4); assert.equal(JSON.stringify(result.body).includes('password_hash'), false)
    assert.equal((await request('/users?page=0', 'GET', undefined, 3)).status, 400)
    assert.equal((await request('/reports', 'GET', undefined, 2)).status, 200)
    assert.equal((await request('/reports')).status, 403)
    // Revoked privileges are read from the DB on each request, not trusted from the browser.
    await db.collection('users').updateOne({ id: people[2].id }, { $set: { role: 'user' } })
    assert.equal((await request('/reports', 'GET', undefined, 2)).status, 403)
  })
  await t.test('only admins assign roles, protect self and invalidate existing sessions', async () => {
    const path = '/users/' + people[1].id + '/role'
    assert.equal((await request(path, 'PATCH', { role: 'admin' }, 0)).status, 403)
    await db.collection('users').updateOne({ id: people[2].id }, { $set: { role: 'staff' } })
    assert.equal((await request(path, 'PATCH', { role: 'admin' }, 2)).status, 403)
    assert.equal((await request(path, 'PATCH', { role: 'business' }, 3)).status, 400)
    assert.equal((await request(path, 'PATCH', { role: 'staff', email_verified: true }, 3)).status, 400)
    assert.equal((await request('/users/' + people[3].id + '/role', 'PATCH', { role: 'user' }, 3)).status, 409)
    assert.equal((await request('/users/missing/role', 'PATCH', { role: 'staff' }, 3)).status, 404)
    await db.collection('users').updateOne({ id: people[1].id }, { $set: { email_verified: false } })
    assert.equal((await request(path, 'PATCH', { role: 'staff' }, 3)).status, 200)
    assert.equal((await db.collection('users').findOne({ id: people[1].id })).email_verified, false)
    await db.collection('users').updateOne({ id: people[1].id }, { $set: { email_verified: true } })
    assert.equal((await request(path, 'PATCH', { role: 'staff' }, 3)).status, 200)
    assert.equal((await request('/me', 'GET', undefined, 1)).status, 401)
    const token = newToken(); tokens[1] = token
    await auth.createSession({ userId: people[1].id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 600000) })
    assert.equal((await request('/me', 'GET', undefined, 1)).body.role, 'staff')
    assert.equal((await request('/reports', 'GET', undefined, 1)).status, 200)
    assert.equal((await request(path, 'PATCH', { role: 'admin' }, 3)).body.role, 'admin')
    assert.equal((await request(path, 'PATCH', { role: 'user' }, 3)).body.role, 'user')
    assert.equal((await request('/reports', 'GET', undefined, 1)).status, 401)
    const saved = await db.collection('users').findOne({ id: people[1].id })
    assert.equal(saved.roleUpdatedBy, people[3].id)
    assert.equal(saved.credential_version, 4)
    const business = (await request('/users', 'GET', undefined, 3)).body.items.find(item => item.id === people[0].id)
    assert.equal(business.effectiveRole, 'business')
  })

})
