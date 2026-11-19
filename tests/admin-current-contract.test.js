import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { newToken, hashToken } from '../src/modules/auth/token.js'

test('current Admin contract: authorization, analytics, filters and role lifecycle', async t => {
  const mongo = await MongoMemoryServer.create(); t.after(() => mongo.stop())
  const client = createClient(readConfig({ MONGODB_URI: mongo.getUri('admin_current') })); await client.connect(); t.after(() => client.close())
  const db = client.db()
  // Existing workspaces already have a full unique nameKey index. Startup must preserve it.
  await db.collection('admin_roles').createIndex({ nameKey: 1 }, { unique: true })
  await initializeDatabase(db); await initializeDatabase(db)
  const auth = createAuthRepository(db), tokens = [], users = []
  for (const role of ['admin', 'user']) {
    const user = await auth.createUser({ name: role, email: role + '@current.example', passwordHash: 'unused' }); users.push(user)
    await db.collection('users').updateOne({ id: user.id }, { $set: { role, email_verified: true, created_at: new Date('2026-11-01T00:00Z') } })
    const token = newToken(); tokens.push(token); await auth.createSession({ userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 600000) })
  }
  const server = createApp(readConfig({}), { authRepository: auth }).listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const request = async (path, method = 'GET', body, who = 0) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/portal/admin${path}`, { method, headers: { 'Content-Type': 'application/json', ...(who === null ? {} : { Authorization: 'Bearer ' + tokens[who] }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  }
  const ok = (result, status = 200) => { assert.equal(result.status, status, JSON.stringify(result.body)); return result.body }
  await t.test('new endpoints are protected and reject ambiguous/injected query parameters', async () => {
    for (const path of ['/dashboard-stats', '/analytics/performance', '/analytics/revenue', '/roles']) {
      ok(await request(path, 'GET', undefined, null), 401); ok(await request(path, 'GET', undefined, 1), 403)
    }
    for (const [path, method, body] of [['/roles', 'POST', { name: 'No access' }], ['/roles/member', 'PUT', { name: 'No access', adminVersion: 0 }], ['/roles/member', 'DELETE', { adminVersion: 0 }]]) ok(await request(path, method, body, 1), 403)
    for (const path of ['/dashboard-stats?period=year', '/dashboard-stats?period=week&period=month', '/analytics/performance?q=x', '/analytics/revenue?year=1e3', '/analytics/revenue?year=2026&month=13', '/analytics/revenue?type=yearly&month=1', '/analytics/revenue?year=2026&year=2025', '/users?sortBy=password_hash', '/posts?sortDirection[$ne]=asc', '/users?dateFrom=2026-02-30', '/users?dateFrom=2026-11-20&dateTo=2026-11-01']) ok(await request(path), 400)
  })
  await t.test('dashboard and performance are complete and return safe values on an empty dataset', async () => {
    const dashboard = ok(await request('/dashboard-stats?period=week'))
    assert.equal(dashboard.users, 2); assert.equal(dashboard.usersByRole.admin, 1); assert.equal(dashboard.usersByRole.member, 1)
    assert.equal(dashboard.trend.buckets.length, 7); assert.equal(dashboard.activities.active, 0)
    assert.deepEqual(dashboard.pendingBusinessItems, []); assert.deepEqual(dashboard.upcomingActivityItems, [])
    const performance = ok(await request('/analytics/performance'))
    assert.deepEqual(performance.lateArrival, { late: 0, present: 0, total: 0, rate: 0 })
    assert.equal(performance.businessCancellation.rate, 0)
  })
  await t.test('date filters include the complete Vietnam day; sorting precedes pagination', async () => {
    await db.collection('users').insertMany([
      { id: 'before', name: 'Before', email: 'before@example.com', created_at: new Date('2026-11-17T16:59:59Z') },
      { id: 'first', name: 'Alpha', email: 'first@example.com', created_at: new Date('2026-11-17T17:00:00Z'), email_verified: true },
      { id: 'last', name: 'Zulu', email: 'last@example.com', createdAt: new Date('2026-11-18T16:59:59Z') },
      { id: 'after', name: 'After', email: 'after@example.com', created_at: new Date('2026-11-18T17:00:00Z') },
    ])
    const path = '/users?dateFrom=2026-11-18&dateTo=2026-11-18&sortBy=name&sortDirection='
    let result = ok(await request(path + 'asc')); assert.equal(result.total, 2); assert.deepEqual(result.items.map(row => row.id), ['first', 'last'])
    result = ok(await request(path + 'desc')); assert.deepEqual(result.items.map(row => row.id), ['last', 'first'])
    result = ok(await request('/users?dateFrom=2026-11-18&dateTo=2026-11-18&status=active&sortBy=status')); assert.deepEqual(result.items.map(row => row.id), ['first'])
    await db.collection('business_posts').insertMany([{ id: 'post-b', title: 'Bravo', status: 'pending', createdAt: new Date('2026-11-18T10:00Z') }, { id: 'post-a', title: 'Alpha', status: 'rejected', createdAt: new Date('2026-11-18T11:00Z') }])
    result = ok(await request('/posts?dateFrom=2026-11-18&dateTo=2026-11-18&sortBy=title&sortDirection=asc')); assert.deepEqual(result.items.map(row => row.id), ['post-a', 'post-b'])
    assert.equal(result.items[0]._created, undefined)
  })
  await t.test('revenue recognizes only completed payout fees in their processed Vietnam period', async () => {
    await db.collection('finance_escrows').insertOne({ _id: 'ledger', payouts: [
      { id: 'previous', status: 'completed', processedAt: new Date('2026-10-31T16:59:59Z'), amount: 900, feeAmount: 100 },
      { id: 'start', status: 'completed', processedAt: new Date('2026-10-31T17:00:00Z'), amount: 1800, feeAmount: 200 },
      { id: 'end', status: 'completed', processedAt: new Date('2026-11-30T16:59:59Z'), amount: 2700, feeAmount: 300 },
      { id: 'outside', status: 'completed', processedAt: new Date('2026-11-30T17:00:00Z'), amount: 3600, feeAmount: 400 },
      { id: 'processing', status: 'processing', processedAt: new Date('2026-11-15T00:00Z'), amount: 99999, feeAmount: 9999 },
    ], lots: [{ amount: 999999, state: 'held' }] })
    const value = ok(await request('/analytics/revenue?type=monthly&year=2026&month=11'))
    assert.equal(value.totalRevenue, 500); assert.equal(value.previousRevenue, 100); assert.equal(value.growthPercentage, 400)
    assert.equal(value.settledPayouts, 4500); assert.equal(value.transactions, 2); assert.equal(value.buckets.length, 30)
    assert.equal(value.buckets[0].revenue, 200); assert.equal(value.buckets[29].revenue, 300)
    const yearly = ok(await request('/analytics/revenue?type=yearly&year=2026'))
    assert.equal(yearly.totalRevenue, 1000); assert.equal(yearly.buckets.length, 12)
    const empty = ok(await request('/analytics/revenue?type=monthly&year=2024&month=2'))
    assert.equal(empty.buckets.length, 29); assert.equal(empty.totalRevenue, 0)
  })
  await t.test('performance and dashboard use persisted data, bounded queues and completed periods', async () => {
    await db.collection('activities').insertMany([
      { id: 'attended', hostId: users[1].id, title: 'Past', organizerType: 'personal', status: 'completed', createdAt: new Date(), location: 'Cafe', province: 'TP.HCM', district: 'Quận 1', memberCount: 3, attendance: [{ status: 'late' }, { status: 'present' }, { status: 'absent' }] },
      { id: 'cancelled', title: 'Cancelled', organizerType: 'business', status: 'cancelled' },
      { id: 'upcoming', title: 'Next', organizerType: 'business', status: 'published', startsAt: new Date(Date.now() + 86400000), location: 'Cafe', province: 'Ho Chi Minh City', district: 'Quận 1', memberCount: 2 },
      { id: 'deleted', title: 'Deleted', organizerType: 'business', status: 'deleted', attendance: [{ status: 'late' }] },
    ])
    const value = ok(await request('/analytics/performance'))
    assert.equal(value.lateArrival.rate, 50); assert.equal(value.lateArrival.total, 2)
    assert.equal(value.businessCancellation.total, 4); assert.equal(value.businessCancellation.cancelledOrRejected, 2)
    assert.deepEqual(value.topCities[0], { name: 'TP. Hồ Chí Minh', area: '', activityCount: 2, participantCount: 5 })
    assert.deepEqual(value.topDistricts[0], { name: 'Quận 1', area: 'TP. Hồ Chí Minh', activityCount: 2, participantCount: 5 })
    const dashboard = ok(await request('/dashboard-stats?period=month'))
    assert.equal(dashboard.usersByRole.host, 1); assert.equal(dashboard.upcomingActivityItems[0].id, 'upcoming')
    assert.ok(dashboard.pendingPostItems.length <= 5); assert.ok(dashboard.recentActivity.length <= 10)
    const deterministic = await auth.portal.admin.dashboard({ period: 'week' }, new Date('2026-11-23T01:00:00Z'))
    assert.equal(deterministic.growth.users.current, 4); assert.equal(deterministic.growth.users.previous, 0)
  })
  await t.test('custom roles persist, validate revisions and do not grant administrator access', async () => {
    const roles = ok(await request('/roles')); assert.ok(roles.find(role => role.id === 'member' && role.assignable)); assert.ok(roles.find(role => role.id === 'host' && !role.assignable))
    let role = ok(await request('/roles', 'POST', { name: 'Volunteers', description: 'Community helpers' }), 201)
    ok(await request('/roles', 'POST', { name: ' volunteers ' }), 409)
    ok(await request('/roles/admin', 'PUT', { name: 'Renamed', adminVersion: 0 }), 409)
    ok(await request('/roles/member', 'DELETE', { adminVersion: 0 }), 409)
    const result = ok(await request('/roles/' + role.id, 'PUT', { name: 'Helpers', description: 'Updated', adminVersion: role.adminVersion }))
    ok(await request('/roles/' + role.id, 'PUT', { name: 'Stale', adminVersion: role.adminVersion }), 409); role = result
    let member = ok(await request('/users', 'POST', { name: 'Role member', email: 'role-member@example.com', password: 'secret123', roleId: role.id }), 201)
    assert.equal(member.role, 'user'); assert.equal(member.adminRoleId, role.id)
    assert.equal(ok(await request('/users?role=' + role.id)).total, 1)
    ok(await request('/roles/' + role.id, 'DELETE', { adminVersion: role.adminVersion }), 409)
    const sessionToken = newToken(); await auth.createSession({ userId: member.id, tokenHash: hashToken(sessionToken), expiresAt: new Date(Date.now() + 600000) })
    assert.equal(await auth.portal.access(member.id), 'user')
    member = ok(await request('/users/' + member.id, 'PUT', { name: member.name, roleId: 'admin', adminVersion: member.adminVersion }))
    assert.equal(member.role, 'admin'); assert.equal(await auth.findSession(hashToken(sessionToken)), null)
    ok(await request('/users/' + member.id, 'PUT', { name: member.name, roleId: 'member', adminVersion: member.adminVersion - 1 }), 409)
    ok(await request('/users/' + users[0].id, 'PUT', { name: 'admin', roleId: 'member', adminVersion: 0 }), 409)
    ok(await request('/users', 'POST', { name: 'Fake Host', email: 'fake-host@example.com', password: 'secret123', roleId: 'host' }), 400)
    ok(await request('/roles/' + role.id, 'DELETE', { adminVersion: role.adminVersion }))
    assert.ok(!ok(await request('/roles')).some(item => item.id === role.id))
    ok(await request('/roles', 'POST', { name: 'Helpers', description: 'Reuses a deleted name' }), 201)
    ok(await request('/users', 'POST', { name: 'Deleted role', email: 'deleted-role@example.com', password: 'secret123', roleId: role.id }), 400)
  })
})
