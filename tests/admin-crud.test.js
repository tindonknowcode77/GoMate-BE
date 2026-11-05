import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { PDFDocument } from 'pdf-lib'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { newToken, hashToken } from '../src/modules/auth/token.js'

test('admin CRUD authorizes every resource, persists changes, rejects stale edits and preserves history', async t => {
  const mongo = await MongoMemoryServer.create(); t.after(() => mongo.stop())
  const client = createClient(readConfig({ MONGODB_URI: mongo.getUri('admin_crud') })); await client.connect(); t.after(() => client.close())
  const db = client.db(); await initializeDatabase(db)
  const auth = createAuthRepository(db), tokens = [], users = []
  for (const role of ['admin', 'user']) {
    const user = await auth.createUser({ name: role, email: role + '@example.com', passwordHash: 'unused' }); users.push(user)
    await db.collection('users').updateOne({ id: user.id }, { $set: { role, email_verified: true } })
    const token = newToken(); tokens.push(token); await auth.createSession({ userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 600000) })
  }
  const server = createApp(readConfig({}), { authRepository: auth }).listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)))
  const request = async (path, method = 'GET', body, who = 0) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/portal` + path, { method, headers: { Authorization: 'Bearer ' + tokens[who], 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  }
  for (const kind of ['users', 'businesses', 'posts', 'reports', 'tickets']) {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) assert.equal((await request('/admin/' + kind + (['PUT', 'DELETE'].includes(method) ? '/missing' : ''), method, method === 'GET' ? undefined : {}, 1)).status, 403)
  }
  assert.equal((await request('/admin/unknown')).status, 404)
  assert.equal((await request('/admin/users?page=0')).status, 400)
  const created = await request('/admin/users', 'POST', { name: 'CRUD Person', email: 'crud@example.com', password: 'secret123' })
  assert.equal(created.status, 201); const user = created.body
  assert.equal(user.password_hash, undefined); assert.equal(user.email_verified, false)
  assert.equal((await request('/admin/users', 'POST', { name: 'Duplicate', email: user.email, password: 'secret123' })).status, 409)
  assert.equal((await request('/admin/users', 'POST', { name: 'Escalation', email: 'bad@example.com', password: 'secret123', role: 'admin' })).status, 400)
  let result = await request('/admin/users/' + user.id, 'PUT', { name: 'Edited CRUD', adminVersion: user.adminVersion }); assert.equal(result.status, 200)
  assert.equal((await request('/admin/users/' + user.id, 'PUT', { name: 'Stale', adminVersion: user.adminVersion })).status, 409)
  const currentUser = result.body
  assert.equal((await request('/admin/users?q=Edited')).body.total, 1)
  assert.equal((await request('/admin/users?q=.*')).body.total, 0)
  assert.equal((await request('/admin/users/' + users[0].id, 'DELETE', { adminVersion: 0 })).status, 409)
  const pdf = await PDFDocument.create(); pdf.addPage()
  const application = { company: 'CRUD Business', category: 'Events', taxId: '0312345678', address: '12 Main Street', website: '', representativeName: 'Owner', representativeTitle: 'Director', representativeEmail: 'owner@example.com', representativePhone: '0901234567', document: { name: 'license.pdf', mime: 'application/pdf', base64: Buffer.from(await pdf.save()).toString('base64') } }
  result = await request('/admin/businesses', 'POST', { ownerId: user.id, application }); assert.equal(result.status, 201); let business = result.body
  assert.equal(business.document, undefined)
  const { company, address, website, representativeName, representativeTitle, representativeEmail, representativePhone } = application
  result = await request('/admin/businesses/' + business.id, 'PUT', { company: company + ' Updated', address, website, representativeName, representativeTitle, representativeEmail, representativePhone, version: business.version, adminVersion: 0 })
  assert.equal(result.status, 200); business = result.body
  assert.equal((await request('/applications/' + business.id, 'PATCH', { status: 'approved', reviewNote: '', version: business.version - 1 })).status, 409)
  assert.equal((await request('/applications/' + business.id, 'PATCH', { status: 'approved', reviewNote: '', version: business.version })).status, 200)
  const post = { title: 'CRUD Post', copy: 'Description', border: 'Solid', premium: false }
  result = await request('/admin/posts', 'POST', { ownerId: user.id, post }); assert.equal(result.status, 201); let savedPost = result.body
  result = await request('/admin/posts/' + savedPost.id, 'PUT', { adminVersion: 0, version: savedPost.version, post: { ...post, title: 'Edited Post' } }); assert.equal(result.status, 200); savedPost = result.body
  assert.equal((await request('/admin/businesses/' + business.id, 'DELETE', { adminVersion: business.adminVersion, version: business.version + 1 })).status, 409)
  result = await request('/admin/posts/' + savedPost.id, 'DELETE', { adminVersion: 0, version: savedPost.version }); assert.equal(result.status, 200)
  assert.equal((await request('/admin/posts')).body.total, 0)
  assert.equal((await db.collection('business_posts').findOne({ id: savedPost.id })).status, 'deleted')
  result = await request('/admin/businesses/' + business.id); business = result.body
  assert.equal((await request('/admin/businesses/' + business.id, 'DELETE', { adminVersion: business.adminVersion, version: business.version })).status, 200)
  assert.equal((await request('/admin/businesses')).body.total, 0)
  await db.collection('activities').insertOne({ id: 'activity', hostId: users[1].id, status: 'published', title: 'Reported Activity' })
  result = await request('/admin/reports', 'POST', { activityId: 'activity', reason: 'Unsafe', detail: 'Please review' }); assert.equal(result.status, 201); let report = result.body
  assert.equal((await request('/admin/reports/' + report.id, 'DELETE', { adminVersion: report.adminVersion })).status, 409)
  result = await request('/admin/reports/' + report.id, 'PUT', { adminVersion: report.adminVersion, detail: 'Updated detail' }); assert.equal(result.status, 200); report = result.body
  assert.equal((await request('/reports/' + report.id, 'PATCH', { status: 'resolved', hideActivity: false })).status, 200)
  assert.equal((await request('/admin/reports/' + report.id, 'PUT', { adminVersion: report.adminVersion, detail: 'Cannot rewrite resolved' })).status, 409)
  assert.equal((await request('/admin/reports/' + report.id, 'DELETE', { adminVersion: report.adminVersion })).status, 200)
  assert.equal((await request('/admin/reports')).body.total, 0)
  result = await request('/admin/tickets', 'POST', { ownerId: users[1].id, subject: 'Help', message: 'Question' }); assert.equal(result.status, 201); let ticket = result.body
  assert.equal((await request('/admin/tickets/' + ticket.id, 'DELETE', { adminVersion: 0 })).status, 409)
  assert.equal((await request('/tickets/' + ticket.id + '/replies', 'POST', { message: 'Answer', status: 'closed' })).status, 200)
  assert.equal((await request('/admin/tickets/' + ticket.id, 'PUT', { adminVersion: 0, subject: 'Stale update', status: 'open' })).status, 409)
  result = await request('/admin/tickets/' + ticket.id); ticket = result.body
  assert.equal(ticket.messages.length, 2)
  result = await request('/admin/tickets/' + ticket.id, 'PUT', { adminVersion: ticket.adminVersion, subject: 'Resolved help', status: 'closed' }); assert.equal(result.status, 200); ticket = result.body
  assert.equal((await request('/admin/tickets/' + ticket.id, 'DELETE', { adminVersion: ticket.adminVersion })).status, 200)
  assert.equal((await request('/tickets', 'GET', undefined, 1)).body.total, 0)
  assert.equal((await request('/tickets/' + ticket.id + '/replies', 'POST', { message: 'Cannot reopen', status: 'open' }, 1)).status, 404)
  const token = newToken(); await auth.createSession({ userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 600000) })
  assert.ok(await auth.findSession(hashToken(token)))
  assert.equal((await request('/admin/users/' + user.id, 'DELETE', { adminVersion: currentUser.adminVersion })).status, 200)
  assert.equal(await auth.findSession(hashToken(token)), null)
  assert.equal((await request('/admin/users/' + user.id)).status, 404)
  assert.ok((await db.collection('users').findOne({ id: user.id })).deletedAt)
  await db.collection('users').insertMany(Array.from({ length: 23 }, (_, index) => ({ id: 'page-' + index, name: 'Pagination ' + index, email: `page-${index}@example.com`, created_at: new Date() })))
  assert.equal((await request('/admin/users?page=1')).body.items.length, 20)
  result = await request('/admin/users?page=2'); assert.equal(result.body.total, 25); assert.equal(result.body.items.length, 5)
})
