import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import sharp from 'sharp'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { readConfig } from '../src/config/env.js'
import { createApp } from '../src/app.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { createActivityRepository } from '../src/modules/activities/repository.js'
import { createActivityScheduler } from '../src/modules/activities/scheduler.js'
import { hashToken, newToken } from '../src/modules/auth/token.js'

test('member attendance reputation, protected complaints and single-confirmation refunds', async t => {
  const mongo = await MongoMemoryServer.create(), client = createClient(readConfig({ MONGODB_URI: mongo.getUri('member_attendance') }))
  let server
  try {
    await client.connect(); const db = client.db(); await initializeDatabase(db)
    const auth = createAuthRepository(db), users = [], tokens = []
    for (let index = 0; index < 5; index++) {
      const user = await auth.createUser({ name: `Attendance ${index}`, email: `attendance${index}@example.com`, passwordHash: 'unused' }); users.push(user)
      await db.collection('users').updateOne({ id: user.id }, { $set: { role: index < 2 ? 'admin' : 'user', email_verified: true } })
      tokens.push(newToken()); await auth.createSession({ userId: user.id, tokenHash: hashToken(tokens[index]), expiresAt: new Date(Date.now() + 3600000) })
    }
    server = createApp(readConfig({}), { authRepository: auth, activityRepository: createActivityRepository(db) }).listen(0, '127.0.0.1'); await once(server, 'listening')
    const base = `http://127.0.0.1:${server.address().port}/api`
    const call = async (who, path, method = 'GET', body) => {
      const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(who === null ? {} : { Authorization: `Bearer ${tokens[who]}` }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      return { status: response.status, body: response.status === 204 ? null : await response.json() }
    }
    const success = result => { assert.ok(result.status < 300, JSON.stringify(result.body)); return result.body }
    const make = async (status = 'completed', mark = 'absent') => {
      const id = randomUUID(), now = new Date()
      await db.collection('activities').insertOne({ id, title: 'Attendance workshop', hostId: users[2].id, hostName: users[2].name, organizerType: 'personal', status, version: 1, startsAt: new Date(+now - 3600000), endsAt: new Date(+now + 3600000), ...(status !== 'published' ? { startedAt: now } : {}), scheduleConfirmedAt: now, memberCount: 2, maxParticipants: 10, joinRequests: [{ userId: users[3].id, name: users[3].name, status: 'approved' }], attendance: [{ userId: users[2].id, name: users[2].name, status: 'present' }, { userId: users[3].id, name: users[3].name, status: mark, updatedAt: now, updatedBy: users[2].id }], updates: [] })
      return id
    }
    const submit = id => ({ activityId: id, kind: 'attendance', requestedStatus: 'present', detail: 'Tôi có mặt đúng giờ, có ảnh nhóm và người tham gia xác nhận.' })
    let absentId, complaintId
    await t.test('own/public profiles expose the same Bayesian attendance rate; new users default to 100%; cancellations and host cancels are distinguished and reputation recovers', async () => {
      absentId = await make(); await make('completed', 'present'); await make('completed', 'late'); await make('completed', 'unmarked'); await make('cancelled', 'absent'); await make('in-progress', 'absent')
      await db.collection('activity_ratings').insertOne({ id: randomUUID(), activityId: absentId, authorId: users[2].id, targetUserId: users[3].id, score: 4, createdAt: new Date() })
      const own = success(await call(3, '/profile/me')).profile.reputation, other = success(await call(4, '/profile/' + users[3].id)).reputation
      assert.deepEqual(own, other); assert.equal(own.average, 4); assert.equal(own.count, 1)
      // (10 + 2 attended) / (10 + 2 + 1 absent) = 12/13 = 92.3%
      assert.equal(own.attendanceCount, 3); assert.equal(own.attendedCount, 2); assert.equal(own.absentCount, 1)
      assert.equal(own.attendanceRate, 92.3); assert.equal(own.absenceRate, 7.7); assert.equal(own.isNewUser, false)
      assert.equal(own.hostCancelledCount, 1)
      // New user with 0 recorded activities defaults to 100% and is flagged as isNewUser
      const freshRep = success(await call(4, '/profile/me')).profile.reputation
      assert.equal(freshRep.attendanceRate, 100); assert.equal(freshRep.absenceRate, 0); assert.equal(freshRep.isNewUser, true)
      // Distinguish on-time cancel (>6h: no penalty), late cancel (<=6h: 0.5 weight -> 95.2%), host cancel (0 penalty), and recovery
      const onTimeActId = randomUUID(), lateActId = randomUUID(), hostCancelActId = randomUUID()
      const futureEarly = new Date(Date.now() + 24 * 3600000), futureLate = new Date(Date.now() + 2 * 3600000)
      await db.collection('activities').insertMany([
        { id: onTimeActId, title: 'On-time leave', hostId: users[2].id, hostName: users[2].name, organizerType: 'personal', status: 'published', version: 1, startsAt: futureEarly, endsAt: new Date(+futureEarly + 3600000), memberCount: 2, maxParticipants: 10, joinRequests: [{ userId: users[4].id, name: users[4].name, status: 'approved' }], attendance: [], updates: [] },
        { id: lateActId, title: 'Late leave', hostId: users[2].id, hostName: users[2].name, organizerType: 'personal', status: 'published', version: 1, startsAt: futureLate, endsAt: new Date(+futureLate + 3600000), memberCount: 2, maxParticipants: 10, joinRequests: [{ userId: users[4].id, name: users[4].name, status: 'approved' }], attendance: [], updates: [] },
        { id: hostCancelActId, title: 'Host cancelled', hostId: users[2].id, hostName: users[2].name, organizerType: 'personal', status: 'cancelled', version: 1, startsAt: futureLate, endsAt: new Date(+futureLate + 3600000), memberCount: 2, maxParticipants: 10, joinRequests: [{ userId: users[4].id, name: users[4].name, status: 'left', leaveType: 'late' }], attendance: [], updates: [] },
      ])
      assert.equal((await call(4, `/activities/${onTimeActId}/members/me`, 'DELETE', {})).status, 204)
      let rep4 = success(await call(4, '/profile/me')).profile.reputation
      assert.equal(rep4.onTimeCancelCount, 1); assert.equal(rep4.hostCancelledCount, 1); assert.equal(rep4.attendanceRate, 100); assert.equal(rep4.isNewUser, true)
      assert.equal((await call(4, `/activities/${lateActId}/members/me`, 'DELETE', { reason: 'Có việc gia đình đột xuất không thể đi' })).status, 204)
      rep4 = success(await call(4, '/profile/me')).profile.reputation
      assert.equal(rep4.lateCancelCount, 1); assert.equal(rep4.attendanceRate, 95.2); assert.equal(rep4.isNewUser, false)
      // Attending a new completed activity recovers reputation upward from 95.2% -> 11/11.5 = 95.7%
      const recoveryId = randomUUID()
      await db.collection('activities').insertOne({ id: recoveryId, title: 'Recovery run', hostId: users[2].id, hostName: users[2].name, organizerType: 'personal', status: 'completed', version: 1, startsAt: new Date(Date.now() - 7200000), endsAt: new Date(Date.now() - 3600000), startedAt: new Date(Date.now() - 7200000), memberCount: 2, maxParticipants: 10, joinRequests: [{ userId: users[4].id, name: users[4].name, status: 'approved' }], attendance: [{ userId: users[4].id, name: users[4].name, status: 'present' }], updates: [] })
      const recovered = success(await call(4, '/profile/me')).profile.reputation
      assert.ok(recovered.attendanceRate > rep4.attendanceRate, `expected recovery ${recovered.attendanceRate} > ${rep4.attendanceRate}`)
      assert.equal(recovered.attendanceRate, 95.7)
      // Clean up test fixture docs for users[4] so later subtests remain isolated
      await db.collection('activities').deleteMany({ id: { $in: [onTimeActId, lateActId, hostCancelActId, recoveryId] } })
      assert.equal((await call(null, '/profile/' + users[3].id)).status, 401)
    })
    await t.test('start-unmarked and absent notifications reach the affected user, deduplicate and honor participant scope', async () => {
      await auth.community.saveSettings(users[3].id, { notifyActivity: false })
      const id = await make('published', 'unmarked')
      success(await call(2, `/activities/${id}/start`, 'POST', {}))
      let notices = success(await call(3, '/community/notifications')).items
      assert.ok(notices.some(item => item.activityId === id && item.title === 'Bạn chưa được điểm danh' && item.type === 'attendance'))
      await createActivityScheduler(db, auth.community).tick()
      assert.equal(await db.collection('notifications').countDocuments({ userId: users[3].id, key: { $regex: '^attendance-start:' + id } }), 1)
      success(await call(2, `/activities/${id}/attendance/${users[3].id}`, 'PATCH', { status: 'absent' }))
      notices = success(await call(3, '/community/notifications')).items
      assert.ok(notices.some(item => item.activityId === id && item.title === 'Trạng thái điểm danh: Vắng mặt'))
      assert.equal(await db.collection('notifications').countDocuments({ userId: users[4].id, activityId: id }), 0)
    })
    await t.test('complaints require membership and validation; duplicate submits create one pending report', async () => {
      assert.equal((await call(4, '/community/attendance/complaints', 'POST', submit(absentId))).status, 403)
      assert.equal((await call(3, '/community/attendance/complaints', 'POST', { ...submit(absentId), reporterId: users[4].id })).status, 400)
      assert.equal((await call(3, '/community/attendance/complaints', 'POST', { ...submit(absentId), detail: 'short' })).status, 400)
      const results = await Promise.all([call(3, '/community/attendance/complaints', 'POST', submit(absentId)), call(3, '/community/attendance/complaints', 'POST', submit(absentId))])
      complaintId = success(results[0]).report.id; assert.equal(success(results[1]).report.id, complaintId)
      assert.equal((await call(3, `/community/moderation/attendance-complaints/${complaintId}`, 'PATCH', { decision: 'approve', status: 'present', note: 'Unauthorized correction attempt' })).status, 403)
      assert.equal((await call(0, `/portal/reports/${complaintId}`, 'PATCH', { status: 'resolved', hideActivity: false })).status, 400)
      assert.ok(success(await call(3, '/community/reports')).items.some(item => item.id === complaintId))
      assert.ok(!success(await call(4, '/community/reports')).items.some(item => item.id === complaintId))
    })
    await t.test('Admin correction updates reputation, records one audit event, notifies and cannot be replayed with a different outcome', async () => {
      const body = { decision: 'approve', status: 'present', note: 'Đã đối chiếu ảnh nhóm và xác nhận người tham gia.' }
      success(await call(0, `/community/moderation/attendance-complaints/${complaintId}`, 'PATCH', body))
      success(await call(0, `/community/moderation/attendance-complaints/${complaintId}`, 'PATCH', body))
      const row = await db.collection('activities').findOne({ id: absentId })
      assert.equal(row.attendance.find(item => item.userId === users[3].id).status, 'present')
      assert.equal(row.updates.filter(item => item.reportId === complaintId).length, 1)
      const rep = success(await call(3, '/profile/me')).profile.reputation
      assert.equal(rep.absenceRate, 0); assert.equal(rep.attendanceCount, 3)
      assert.equal((await call(1, `/community/moderation/attendance-complaints/${complaintId}`, 'PATCH', { ...body, status: 'absent' })).status, 409)
      assert.ok(success(await call(3, '/community/notifications')).items.some(item => item.type === 'attendance' && item.title === 'Khiếu nại đã được xử lý'))
      assert.ok(success(await call(3, '/community/reports')).items.find(item => item.id === complaintId).reviewNote)
    })
    await t.test('host cannot overwrite an Admin correction, including automatic completion of an unmarked correction', async () => {
      const id = await make('in-progress', 'absent'), report = success(await call(3, '/community/attendance/complaints', 'POST', submit(id))).report
      success(await call(0, `/community/moderation/attendance-complaints/${report.id}`, 'PATCH', { decision: 'approve', status: 'unmarked', note: 'Chưa có bằng chứng kết luận vắng; xóa đánh dấu sai.' }))
      assert.equal((await call(2, `/activities/${id}/attendance/${users[3].id}`, 'PATCH', { status: 'absent' })).status, 409)
      success(await call(2, `/activities/${id}/complete`, 'POST', {}))
      assert.equal((await db.collection('activities').findOne({ id })).attendance.find(item => item.userId === users[3].id).status, 'unmarked')
    })
    await t.test('stale attendance cannot be overwritten; rejecting and other-issue complaints do not modify attendance', async () => {
      const id = await make('in-progress', 'absent'), report = success(await call(3, '/community/attendance/complaints', 'POST', submit(id))).report
      success(await call(2, `/activities/${id}/attendance/${users[3].id}`, 'PATCH', { status: 'late' }))
      assert.equal((await call(0, `/community/moderation/attendance-complaints/${report.id}`, 'PATCH', { decision: 'approve', status: 'present', note: 'Attempt using stale attendance snapshot' })).status, 409)
      success(await call(0, `/community/moderation/attendance-complaints/${report.id}`, 'PATCH', { decision: 'reject', note: 'Host đã sửa điểm danh; kết quả hiện tại là đến muộn.' }))
      const other = success(await call(3, '/community/attendance/complaints', 'POST', { activityId: id, kind: 'other', detail: 'Tôi cần hỗ trợ về thông tin và chất lượng hoạt động.' })).report
      success(await call(0, `/community/moderation/attendance-complaints/${other.id}`, 'PATCH', { decision: 'approve', note: 'Admin đã liên hệ để giải quyết phản ánh về hoạt động.' }))
      assert.equal((await db.collection('activities').findOne({ id })).attendance.find(item => item.userId === users[3].id).status, 'late')
    })
    await t.test('concurrent conflicting Admin decisions apply a single correction', async () => {
      const id = await make('completed', 'absent'), report = success(await call(3, '/community/attendance/complaints', 'POST', submit(id))).report
      const results = await Promise.all([0, 1].map((who) => auth.community.attendance.resolve(users[who].id, report.id, { decision: 'approve', status: who === 0 ? 'present' : 'late', note: 'Independent administrative correction decision' }).then(() => 200, error => error.status)))
      assert.deepEqual(results.sort(), [200, 409]); assert.equal((await db.collection('activities').findOne({ id })).updates.filter(item => item.reportId === report.id).length, 1)
    })
    await t.test('refund QR freezes beneficiary and exact refund amount, requires a real bill, remains locked and completes idempotently', async () => {
      const id = await make(), paymentId = randomUUID(), refundId = randomUUID(), bank = { bankId: 'MB', accountNo: '1234567890', accountName: 'MEMBER DEMO' }
      await db.collection('payments').insertOne({ id: paymentId, orderCode: 'GM' + randomUUID(), userId: users[3].id, activityId: id, amount: 50000, status: 'paid' })
      await db.collection('finance_escrows').insertOne({ _id: id, activityId: id, ownerId: users[2].id, version: 0, payouts: [], audit: [], settlement: { status: 'waiting' }, lots: [{ paymentId, userId: users[3].id, amount: 50000, state: 'refund_requested', refund: { id: refundId, status: 'pending', amount: 40000, bankAccount: bank, reason: 'Hoàn cọc sau khiếu nại', policy: 'partial_refund_80' } }] })
      const path = `/portal/finance/refunds/${paymentId}`
      assert.equal((await call(3, path + '/prepare-transfer', 'POST', {})).status, 403)
      const prepared = success(await call(0, path + '/prepare-transfer', 'POST', {}))
      assert.equal(prepared.refund.status, 'processing'); assert.equal(new URL(prepared.transfer.qrImageUrl).searchParams.get('amount'), '40000')
      assert.equal(prepared.transfer.bankAccount.accountNo, bank.accountNo)
      assert.deepEqual(success(await call(0, path + '/transfer')).transfer, prepared.transfer)
      await assert.rejects(() => auth.finance.reviewRefund(users[0].id, paymentId, { action: 'complete', note: 'No bill legacy bypass', transferRef: 'BYPASS-0001' }), error => error.status === 400)
      await assert.rejects(() => auth.finance.resolveDispute(users[0].id, id, paymentId, 'Try to release during transfer', 'release'), error => error.status === 409)
      assert.equal((await call(0, path + '/receipt', 'POST', { receipt: { name: 'bad.png', mime: 'image/png', base64: 'YWJj' } })).status, 400)
      const receipt = { name: 'bill.png', mime: 'image/png', base64: (await sharp({ create: { width: 80, height: 120, channels: 3, background: '#abcdab' } }).png().toBuffer()).toString('base64') }
      for (let attempt = 0; attempt < 2; attempt++) assert.equal(success(await call(0, path + '/receipt', 'POST', { receipt })).status, 'completed')
      assert.equal((await db.collection('payments').findOne({ id: paymentId })).status, 'refunded')
      assert.equal((await db.collection('finance_escrows').findOne({ _id: id })).audit.filter(item => item.action === 'refund-complete').length, 1)
      assert.ok(success(await call(1, path + '/receipt')).base64)
      assert.equal((await call(3, path + '/receipt')).status, 403)
    })
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await client.close(); await mongo.stop() }
})
