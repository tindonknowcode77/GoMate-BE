import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { PDFDocument } from 'pdf-lib'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { createActivityRepository } from '../src/modules/activities/repository.js'
import { newToken, hashToken } from '../src/modules/auth/token.js'

const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

test('Stage 1 core business rules: time-slot conflicts, host/member ratings, summary, state machine and admin enrichment', async t => {
  const mongod = await MongoMemoryServer.create()
  const config = readConfig({
    MONGODB_URI: mongod.getUri('stage1_rules'),
    PAYMENT_WEBHOOK_SECRET: 's'.repeat(32),
  })
  const client = createClient(config)
  await client.connect()
  const db = client.db()
  await initializeDatabase(db)
  const authRepo = createAuthRepository(db)
  const activityRepo = createActivityRepository(db)
  const app = createApp(config, { authRepository: authRepo, activityRepository: activityRepo })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}/api`

  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    await client.close()
    await mongod.stop()
  })

  async function makeUser(email, name, role = 'user') {
    const user = await authRepo.createUser({ email, name, passwordHash: 'hash' })
    await db.collection('users').updateOne({ id: user.id }, { $set: { email_verified: true, role } })
    const token = newToken()
    await authRepo.createSession({ tokenHash: hashToken(token), userId: user.id, expiresAt: new Date(Date.now() + 86400000) })
    return { ...user, role, token }
  }

  async function call(token, path, method = 'GET', body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }

  const admin = await makeUser('admin@stage1.test', 'Admin User', 'admin')
  const hostA = await makeUser('hosta@stage1.test', 'Host Alpha')
  const hostB = await makeUser('hostb@stage1.test', 'Host Beta')
  const member = await makeUser('member@stage1.test', 'Member One')
  const absentMember = await makeUser('absent@stage1.test', 'Member Absent')
  const bizOwner = await makeUser('biz@stage1.test', 'Business Owner')

  const futureStart = new Date(Date.now() + 48 * 3600000)
  const futureEnd = new Date(futureStart.getTime() + 2 * 3600000)
  const baseDraft = {
    category: 'Cà phê',
    location: 'Quận 1, TP.HCM',
    address: '123 Lê Lợi, Quận 1',
    province: 'TP. Hồ Chí Minh',
    meetingPoint: 'Cổng chính',
    description: 'Hoạt động kiểm thử nghiệp vụ Giai đoạn 1',
    estimatedCost: 50000,
    minParticipants: 2,
    maxParticipants: 6,
    startsAt: futureStart.toISOString(),
    endsAt: futureEnd.toISOString(),
  }

  await t.test('Time-slot conflict: allow multiple pending, auto-cancel overlaps on approval, block confirmed overlap', async () => {
    const actA = (await call(hostA.token, '/activities', 'POST', { ...baseDraft, title: 'Cà phê sáng A' })).body.activity
    const actB = (await call(hostB.token, '/activities', 'POST', { ...baseDraft, title: 'Cà phê sáng B' })).body.activity
    const actC = (await call(hostB.token, '/activities', 'POST', {
      ...baseDraft,
      title: 'Cà phê sáng C',
      startsAt: new Date(futureStart.getTime() + 30 * 60000).toISOString(),
      endsAt: new Date(futureEnd.getTime() + 30 * 60000).toISOString(),
    })).body.activity

    // Member can request both overlapping A and B while pending
    const reqA = await call(member.token, `/activities/${actA.id}/join-requests`, 'POST', {})
    assert.equal(reqA.status, 201)
    assert.equal(reqA.body.overlappingPending.length, 0)

    const reqB = await call(member.token, `/activities/${actB.id}/join-requests`, 'POST', {})
    assert.equal(reqB.status, 201)
    assert.equal(reqB.body.overlappingPending.length, 1)
    assert.equal(reqB.body.overlappingPending[0].activityId, actA.id)

    // Host A approves member -> pending request on B must auto-cancel with notification
    const approved = await call(hostA.token, `/activities/${actA.id}/join-requests/${reqA.body.request.id}`, 'PATCH', { status: 'approved' })
    assert.equal(approved.status, 200)
    assert.equal(approved.body.cancelledConflicts.length, 1)
    assert.equal(approved.body.cancelledConflicts[0].activityId, actB.id)

    const updatedB = await activityRepo.get(actB.id)
    const reqBRecord = updatedB.joinRequests.find(item => item.userId === member.id)
    assert.equal(reqBRecord.status, 'cancelled_conflict')
    assert.equal(reqBRecord.conflictActivityId, actA.id)

    const notices = await call(member.token, '/community/notifications')
    assert.ok(notices.body.items.some(item => item.title === 'Yêu cầu trùng khung giờ đã bị vô hiệu hóa'))

    // Member is now blocked from requesting overlapping C
    const reqC = await call(member.token, `/activities/${actC.id}/join-requests`, 'POST', {})
    assert.equal(reqC.status, 409)
    assert.equal(reqC.body.code, 'SCHEDULE_CONFLICT')
  })

  await t.test('Host vs Member ratings separation & Activity Summary endpoint', async () => {
    const start2 = new Date(Date.now() + 96 * 3600000)
    const end2 = new Date(start2.getTime() + 2 * 3600000)
    const act = (await call(hostA.token, '/activities', 'POST', {
      ...baseDraft,
      title: 'Chạy bộ công viên',
      startsAt: start2.toISOString(),
      endsAt: end2.toISOString(),
    })).body.activity

    const r1 = (await call(member.token, `/activities/${act.id}/join-requests`, 'POST', {})).body.request
    const r2 = (await call(absentMember.token, `/activities/${act.id}/join-requests`, 'POST', {})).body.request
    await call(hostA.token, `/activities/${act.id}/join-requests/${r1.id}`, 'PATCH', { status: 'approved' })
    await call(hostA.token, `/activities/${act.id}/join-requests/${r2.id}`, 'PATCH', { status: 'approved' })

    // Summary unavailable before completion
    assert.equal((await call(member.token, `/activities/${act.id}/summary`)).status, 409)

    const current = await activityRepo.get(act.id)
    assert.equal((await call(hostA.token, `/activities/${act.id}/confirm-schedule`, 'POST', { version: current.version })).status, 200)
    assert.equal((await call(hostA.token, `/activities/${act.id}/start`, 'POST', {})).status, 200)
    await call(hostA.token, `/activities/${act.id}/attendance/${hostA.id}`, 'PATCH', { status: 'present' })
    await call(hostA.token, `/activities/${act.id}/attendance/${member.id}`, 'PATCH', { status: 'late' })
    await call(hostA.token, `/activities/${act.id}/attendance/${absentMember.id}`, 'PATCH', { status: 'absent' })
    assert.equal((await call(hostA.token, `/activities/${act.id}/complete`, 'POST', {})).status, 200)

    // Host rating form: cannot rate own activity, only other attended members
    const hostForm = await call(hostA.token, `/community/ratings/${act.id}`)
    assert.equal(hostForm.status, 200)
    assert.equal(hostForm.body.isHost, true)
    assert.equal(hostForm.body.canRateActivity, false)
    assert.deepEqual(hostForm.body.members.map(m => m.id), [member.id])

    // Host passing activity score is rejected
    const hostBad = await call(hostA.token, `/community/ratings/${act.id}`, 'POST', {
      score: 5,
      comment: 'Self rate',
      members: [{ userId: member.id, score: 5 }],
    })
    assert.equal(hostBad.status, 400)

    // Host rating only members succeeds
    const hostGood = await call(hostA.token, `/community/ratings/${act.id}`, 'POST', {
      score: null,
      comment: '',
      members: [{ userId: member.id, score: 5, note: 'Tham gia nhiệt tình' }],
    })
    assert.equal(hostGood.status, 200)

    // Member rating form: can rate activity & host (excluding self & absent)
    const memberForm = await call(member.token, `/community/ratings/${act.id}`)
    assert.equal(memberForm.status, 200)
    assert.equal(memberForm.body.isHost, false)
    assert.equal(memberForm.body.canRateActivity, true)
    assert.deepEqual(memberForm.body.members.map(m => m.id), [hostA.id])

    // Member without activity score is rejected
    const memberNoScore = await call(member.token, `/community/ratings/${act.id}`, 'POST', {
      score: null,
      comment: 'Missing score',
      members: [{ userId: hostA.id, score: 5 }],
    })
    assert.equal(memberNoScore.status, 400)

    // Member submitting activity score + host rating succeeds and persists activity score
    const memberGood = await call(member.token, `/community/ratings/${act.id}`, 'POST', {
      score: 4,
      comment: 'Hoạt động tổ chức rất ổn',
      members: [{ userId: hostA.id, score: 5 }],
    })
    assert.equal(memberGood.status, 200)

    // Summary endpoint returns exact attendance breakdown & persisted activity rating
    const summaryRes = await call(member.token, `/activities/${act.id}/summary`)
    assert.equal(summaryRes.status, 200)
    const s = summaryRes.body.summary
    assert.equal(s.attendance.total, 3)
    assert.equal(s.attendance.presentCount, 1)
    assert.equal(s.attendance.lateCount, 1)
    assert.equal(s.attendance.absentCount, 1)
    assert.equal(s.attendance.attendedCount, 2)
    assert.equal(s.rating.average, 4)
    assert.equal(s.rating.count, 1)
    assert.equal(s.rating.hasRated, true)
    assert.equal(s.rating.isHost, false)
    assert.equal(s.updates, undefined)
  })

  await t.test('Business state machine enforces scheduleConfirmedAt + deposit on start, and Admin endpoints enrich business/post data & cascade renames', async () => {
    const pdf = await PDFDocument.create()
    pdf.addPage()
    const pdfBase64 = Buffer.from(await pdf.save()).toString('base64')
    const appRes = await call(bizOwner.token, '/portal/applications', 'POST', {
      accountType: 'business',
      country: 'VN',
      company: 'Old Coffee Co',
      category: 'Cà phê, trà và đồ uống',
      website: 'https://oldcoffee.example.com',
      address: '10 Nguyễn Huệ, Q1',
      taxId: '0312345678',
      certificateNumber: 'GPKD-001',
      representativeName: 'Nguyễn Văn B',
      representativeTitle: 'Giám đốc',
      representativeEmail: 'rep@oldcoffee.example.com',
      representativePhone: '+84 909 123 456',
      document: { name: 'license.pdf', mime: 'application/pdf', base64: pdfBase64 },
    })
    assert.equal(appRes.status, 201, JSON.stringify(appRes.body))
    const application = appRes.body

    // Admin business detail has ownerName, ownerEmail, license
    const bizDetail = await call(admin.token, `/portal/admin/businesses/${application.id}`)
    assert.equal(bizDetail.status, 200)
    assert.equal(bizDetail.body.ownerName, 'Business Owner')
    assert.equal(bizDetail.body.ownerEmail, 'biz@stage1.test')

    // Approve business
    assert.equal((await call(admin.token, `/portal/applications/${application.id}`, 'PATCH', {
      status: 'approved',
      reviewNote: 'Hồ sơ hợp lệ',
      version: application.version,
    })).status, 200)

    // Save bank account & verify admin business detail returns it
    assert.equal((await call(bizOwner.token, '/portal/wallet/bank-account', 'PUT', {
      bankId: 'VCB',
      accountNo: '1234567890',
      accountName: 'CONG TY OLD COFFEE',
      branch: 'HCM',
    })).status, 200)
    const bizWithBank = await call(admin.token, `/portal/admin/businesses/${application.id}`)
    assert.equal(bizWithBank.body.bankAccount.bankId, 'VCB')
    assert.equal(bizWithBank.body.reviewerName, 'Admin User')

    // Create business post with deposit
    const gStart = new Date(Date.now() + 144 * 3600000)
    const gEnd = new Date(gStart.getTime() + 2 * 3600000)
    const postRes = await call(bizOwner.token, '/portal/posts', 'POST', {
      title: 'Workshop Pha Chế',
      copy: 'Học pha chế cơ bản cùng chuyên gia.',
      premium: false,
      border: 'Soft',
      discountPercent: 10,
      offer: 'Tặng 1 ly cold brew',
      offerTerms: 'Áp dụng cho thành viên tham gia',
      groups: [{
        name: 'Nhóm Sáng',
        depositAmount: 50000,
        event: {
          category: 'Cà phê',
          location: 'Quận 1, TP.HCM',
          address: '123 Lê Lợi, Quận 1',
          province: 'TP. Hồ Chí Minh',
          meetingPoint: 'Cổng chính',
          estimatedCost: 150000,
          minParticipants: 2,
          maxParticipants: 6,
          startsAt: gStart.toISOString(),
          endsAt: gEnd.toISOString(),
        },
      }],
    })
    assert.equal(postRes.status, 201, JSON.stringify(postRes.body))
    const post = postRes.body

    // Admin post detail returns enriched business info (never raw UUID)
    const postDetail = await call(admin.token, `/portal/admin/posts/${post.id}`)
    assert.equal(postDetail.status, 200)
    assert.equal(postDetail.body.businessId, application.id)
    assert.equal(postDetail.body.businessName, 'Old Coffee Co')
    assert.equal(postDetail.body.business.company, 'Old Coffee Co')
    assert.equal(postDetail.body.ownerEmail, 'biz@stage1.test')

    // Approve post
    const approvedPost = await call(admin.token, `/portal/posts/${post.id}`, 'PATCH', {
      status: 'approved',
      reviewNote: 'Duyệt bài',
      version: post.version,
    })
    assert.equal(approvedPost.status, 200)
    const groupId = approvedPost.body.groups[0].activityId

    // Member joins & gets approved, does NOT pay deposit yet
    const jReq = (await call(member.token, `/activities/${groupId}/join-requests`, 'POST', {})).body.request
    let grp = (await call(bizOwner.token, `/portal/groups/${groupId}`)).body
    grp = (await call(bizOwner.token, `/portal/groups/${groupId}/requests/${jReq.id}`, 'PATCH', { version: grp.version, status: 'approved' })).body

    // Add second member so readiness.ready (minParticipants = 2) is satisfied
    const jReq2 = (await call(absentMember.token, `/activities/${groupId}/join-requests`, 'POST', {})).body.request
    grp = (await call(bizOwner.token, `/portal/groups/${groupId}`)).body
    grp = (await call(bizOwner.token, `/portal/groups/${groupId}/requests/${jReq2.id}`, 'PATCH', { version: grp.version, status: 'approved' })).body

    // Starting directly without scheduleConfirmedAt / deposits must fail with 409!
    const badStart = await call(bizOwner.token, `/portal/groups/${groupId}/actions/start`, 'POST', { version: grp.version })
    assert.equal(badStart.status, 409, JSON.stringify(badStart.body))

    // Admin renames business -> cascades to business_posts and activities!
    const currentBiz = (await call(admin.token, `/portal/admin/businesses/${application.id}`)).body
    const renameRes = await call(admin.token, `/portal/admin/businesses/${application.id}`, 'PUT', {
      adminVersion: currentBiz.adminVersion,
      version: currentBiz.version,
      company: 'New Roastery Co',
      address: currentBiz.address,
      website: currentBiz.website,
      representativeName: currentBiz.representativeName,
      representativeTitle: currentBiz.representativeTitle,
      representativeEmail: currentBiz.representativeEmail,
      representativePhone: currentBiz.representativePhone,
    })
    assert.equal(renameRes.status, 200)

    const postAfterRename = (await call(admin.token, `/portal/admin/posts/${post.id}`)).body
    assert.equal(postAfterRename.businessName, 'New Roastery Co')
    const actAfterRename = await activityRepo.get(groupId)
    assert.equal(actAfterRename.hostName, 'New Roastery Co')
    assert.equal(actAfterRename.business.name, 'New Roastery Co')
  })
})
