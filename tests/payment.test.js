import test from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { createActivityRepository } from '../src/modules/activities/repository.js'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { buildVietQrImageUrl, buildVietQrPayload, crc16Ccitt, generateOrderCode } from '../src/modules/payment/vietqr.js'
import { hashToken, newToken } from '../src/modules/auth/token.js'

test('VietQR payment module and QR scanning flow', async (t) => {
  // 1. Test VietQR standard generator
  await t.test('generates valid VietQR EMVCo string and QR image URL', () => {
    const orderCode = generateOrderCode()
    assert.match(orderCode, /^GM\d{12}$/)

    const payload = buildVietQrPayload({
      bankBin: '970422',
      accountNo: '0901234567',
      amount: 50000,
      description: `${orderCode} COC GOMATE`,
    })

    assert.ok(payload.startsWith('000201010212'))
    assert.ok(payload.includes('A000000727')) // NAPAS AID
    assert.ok(payload.includes('970422'))     // MBBank BIN
    assert.ok(payload.includes('0901234567')) // Account No
    assert.ok(payload.includes('5303704'))    // Currency 704 (VND)
    assert.ok(payload.includes('540550000'))   // Amount 50000

    // Verify CRC16 is 4 hex characters
    const crc = crc16Ccitt(payload.slice(0, -4))
    assert.equal(payload.slice(-4), crc)

    const imageUrl = buildVietQrImageUrl({
      bankId: 'MB',
      accountNo: '0901234567',
      template: 'compact2',
      amount: 50000,
      description: `${orderCode} COC GOMATE`,
      accountName: 'CONG TY GOMATE',
    })

    assert.ok(imageUrl.includes('https://img.vietqr.io/image/MB-0901234567-compact2.png'))
    assert.ok(imageUrl.includes('amount=50000'))
    assert.ok(imageUrl.includes('addInfo='))
  })

  // 2. Test full API with MongoMemoryServer
  const mongo = await MongoMemoryServer.create()
  const client = createClient(readConfig({ MONGODB_URI: mongo.getUri() }))
  await client.connect()
  const db = client.db()
  await initializeDatabase(db)

  const authRepo = createAuthRepository(db)
  const activityRepo = createActivityRepository(db)
  const config = readConfig({
    PORT: 3001,
    PAYMENT_WEBHOOK_SECRET: 's'.repeat(32),
    VIETQR_BANK_ID: 'MB',
    VIETQR_ACCOUNT_NO: '0901234567',
    VIETQR_ACCOUNT_NAME: 'CONG TY GOMATE',
  })

  const app = createApp(config, {
    authRepository: authRepo,
    activityRepository: activityRepo,
  })

  const server = app.listen(0)
  const port = server.address().port
  const base = `http://127.0.0.1:${port}/api`

  try {
    // Create users: host and member
    const host = await authRepo.createUser({ email: 'host@example.com', name: 'Host Business', passwordHash: 'hash' })
    const member = await authRepo.createUser({ email: 'member@example.com', name: 'Member Joiner', passwordHash: 'hash' })
    await db.collection('users').updateOne({ id: member.id }, { $set: { email_verified: true } })

    // Create session token for member
    const token = newToken()
    const tokenHash = hashToken(token)
    await authRepo.createSession({ tokenHash, userId: member.id, expiresAt: new Date(Date.now() + 86400000) })

    await db.collection('business_applications').insertOne({ id: 'initial-biz', ownerId: host.id, status: 'approved' })
    // Create activity with deposit required
    const activity = await activityRepo.create({
      organizerType: 'business',
      depositAmount: 50000,
      estimatedCost: 150000,
      maxParticipants: 10,
      startsAt: new Date(Date.now() + 86400000 * 2),
      endsAt: new Date(Date.now() + 86400000 * 3),
      categories: ['Workshop'],
      location: 'Da Lat',
      title: 'Workshop Da Lat Chup Anh',
      description: 'Chuyen di workshop chup anh',
    }, host)

    // Member joins activity and is approved
    await db.collection('activities').updateOne(
      { id: activity.id },
      {
        $set: {
          status: 'published', memberCount: 2,
          joinRequests: [
            { id: 'req-1', userId: member.id, name: member.name, status: 'approved', createdAt: new Date() },
          ],
        },
      }
    )

    let paymentId = null
    let orderCode = null

    await t.test('POST /api/payments/create-qr creates QR code and payment memo', async () => {
      const res = await fetch(`${base}/payments/create-qr`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          type: 'activity_deposit',
          activityId: activity.id,
        }),
      })

      assert.equal(res.status, 201)
      const data = await res.json()
      assert.ok(data.payment)
      assert.equal(data.payment.amount, 50000)
      assert.equal(data.payment.status, 'pending')
      assert.ok(data.payment.qrPayload.startsWith('000201010212'))
      assert.ok(data.payment.qrImageUrl.includes('vietqr.io'))
      assert.match(data.payment.orderCode, /^GM\d{12}$/)
      assert.equal(data.payment.bank.accountNo, '0901234567')

      paymentId = data.payment.id
      orderCode = data.payment.orderCode
    })

    await t.test('GET /api/payments/:id/status polls status', async () => {
      const res = await fetch(`${base}/payments/${paymentId}/status`, { headers: { Authorization: `Bearer ${token}` } })
      assert.equal(res.status, 200)
      const data = await res.json()
      assert.equal(data.status, 'pending')
      assert.equal(data.orderCode, orderCode)
    })

    await t.test('GET /api/payments/activity/:activityId/me returns pending payment status', async () => {
      const res = await fetch(`${base}/payments/activity/${activity.id}/me`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      assert.equal(res.status, 200)
      const data = await res.json()
      assert.equal(data.depositRequired, true)
      assert.equal(data.depositAmount, 50000)
      assert.equal(data.isPaid, false)
      assert.equal(data.pendingPayment.id, paymentId)
    })

    await t.test('POST /api/payments/webhook confirms payment via bank transfer memo', async () => {
      const res = await fetch(`${base}/payments/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-gomate-webhook-secret': 's'.repeat(32) },
        body: JSON.stringify({
          description: `CHUYEN TIEN ${orderCode} COC GOMATE`,
          amount: 50000,
          transactionRef: 'FT2412345678',
          direction: 'in', accountNo: '0901234567',
        }),
      })

      assert.equal(res.status, 200)
      const data = await res.json()
      assert.equal(data.status, 'ok')
      assert.equal(data.payment.status, 'paid')

      // Verify activity businessReceipts has been updated with status paid
      const updatedActivity = await db.collection('activities').findOne({ id: activity.id })
      const receipt = updatedActivity.businessReceipts.find(r => r.userId === member.id)
      assert.ok(receipt, 'Receipt must exist in activity')
      assert.equal(receipt.status, 'paid')
      assert.equal(receipt.amount, 50000)
      assert.equal(receipt.orderCode, orderCode)
    })

    await t.test('GET /api/payments/activity/:activityId/me reflects paid deposit', async () => {
      const res = await fetch(`${base}/payments/activity/${activity.id}/me`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      assert.equal(res.status, 200)
      const data = await res.json()
      assert.equal(data.isPaid, true)
      assert.equal(data.receipt.status, 'paid')
      assert.equal(data.pendingPayment, null)
    })

    await t.test('Idempotent confirm on already paid payment', async () => {
      const res = await fetch(`${base}/payments/${paymentId}/confirm`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      assert.equal(res.status, 200)
      const data = await res.json()
      assert.equal(data.payment.status, 'paid')
    })

    await t.test('GET /api/payments/history returns user payment history and summary', async () => {
      const res = await fetch(`${base}/payments/history`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      assert.equal(res.status, 200)
      const data = await res.json()
      assert.equal(data.total, 1)
      assert.equal(data.items[0].id, paymentId)
      assert.equal(data.summary.totalPaid, 50000)
      assert.equal(data.items[0].refundEligible, true)
    })

    await t.test('Business owner can configure bank account and request payout when activity completes', async () => {
      // Mark host as verified business and complete activity
      await db.collection('users').updateOne({ id: host.id }, { $set: { email_verified: true } })
      await db.collection('activities').updateOne({ id: activity.id }, { $set: { status: 'completed' } })

      const hostToken = newToken()
      await authRepo.createSession({
        tokenHash: hashToken(hostToken),
        userId: host.id,
        expiresAt: new Date(Date.now() + 86400000),
      })

      const saveBankRes = await fetch(`${base}/portal/wallet/bank-account`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${hostToken}`,
        },
        body: JSON.stringify({
          bankId: 'BIDV',
          accountNo: '8876191441',
          accountName: 'NGUYEN NGOC TIN',
          branch: 'CN TP.HCM',
        }),
      })
      assert.equal(saveBankRes.status, 200)
      const savedBank = await saveBankRes.json()
      assert.equal(savedBank.bankAccount.accountNo, '8876191441')

      const payoutRes = await fetch(`${base}/portal/wallet/payouts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${hostToken}`,
        },
        body: JSON.stringify({
          amount: 45000,
          activityId: activity.id, clientRequestId: 'early-payout-attempt',
          note: 'Rút doanh thu sự kiện hoàn tất',
        }),
      })
      assert.equal(payoutRes.status, 409)
      assert.equal((await authRepo.finance.businessWallet(host.id)).paidOutAmount, 0)
    })

    await t.test('POST /api/payments/:id/refund refunds deposit when activity is cancelled', async () => {
      await db.collection('activities').updateOne({ id: activity.id }, { $set: { status: 'cancelled' } })
      const refundRes = await fetch(`${base}/payments/${paymentId}/refund`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          bankId: 'BIDV',
          accountNo: '8876191441',
          accountName: 'NGUYEN NGOC TIN',
          reason: 'Sự kiện bị hủy',
        }),
      })
      assert.equal(refundRes.status, 200)
      const refundData = await refundRes.json()
      assert.equal(refundData.payment.status, 'paid')
      assert.equal(refundData.payment.refundRequest.status, 'pending')
      assert.equal(refundData.payment.financeState, 'refund_requested')
    })

    await t.test('duplicate location and post creation return 409', async () => {
      await db.collection('users').updateOne({ id: host.id }, { $set: { role: 'business', email_verified: true } })
      const bizToken = newToken()
      await authRepo.createSession({ tokenHash: hashToken(bizToken), userId: host.id, expiresAt: new Date(Date.now() + 86400000) })

      const locPayload = { name: 'Studio Quan 1', address: '99 Le Loi', city: 'TP. Hồ Chí Minh', phone: '0909111222', latitude: 10.77, longitude: 106.7 }
      const locRes1 = await fetch(`${base}/portal/locations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bizToken}` },
        body: JSON.stringify(locPayload),
      })
      assert.equal(locRes1.status, 201)
      const loc = await locRes1.json()

      const locRes2 = await fetch(`${base}/portal/locations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bizToken}` },
        body: JSON.stringify(locPayload),
      })
      assert.equal(locRes2.status, 409)

      const postPayload = {
        title: 'Chiến dịch trùng lặp test',
        copy: 'Nội dung giống nhau',
        premium: false,
        border: 'Solid',
        discountPercent: 10,
        offer: 'Tặng nước',
        offerTerms: 'Mỗi khách 1 phần',
        groups: [{
          name: 'Nhóm sáng',
          locationId: loc.id,
          depositAmount: 50000,
          event: { category: 'Workshop', location: 'TP. Hồ Chí Minh', startsAt: '2099-01-01T02:00:00.000Z', endsAt: '2099-01-01T04:00:00.000Z', estimatedCost: 150000, maxParticipants: 5 },
        }],
      }
      const postRes1 = await fetch(`${base}/portal/posts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bizToken}` },
        body: JSON.stringify(postPayload),
      })
      assert.equal(postRes1.status, 201)

      const postRes2 = await fetch(`${base}/portal/posts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bizToken}` },
        body: JSON.stringify(postPayload),
      })
      assert.equal(postRes2.status, 409)
    })

    await t.test('1-member business group leave (> 6h) succeeds with 100% refund', async () => {
      const soloAct = await activityRepo.create({
        organizerType: 'business',
        depositAmount: 50000,
        estimatedCost: 120000,
        maxParticipants: 5,
        startsAt: new Date(Date.now() + 24 * 3600000),
        endsAt: new Date(Date.now() + 26 * 3600000),
        categories: ['Workshop'],
        location: 'TP. Hồ Chí Minh',
        title: 'Solo Member Leave Test',
        description: 'Test 1-member business group leave',
      }, host)
      await db.collection('activities').updateOne(
        { id: soloAct.id },
        {
          $set: {
            status: 'published',
            memberCount: 1,
            joinRequests: [{ id: 'jr-solo', userId: member.id, name: member.name, status: 'approved', createdAt: new Date() }],
          },
        }
      )

      const qrRes = await fetch(`${base}/payments/create-qr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ activityId: soloAct.id }),
      })
      assert.equal(qrRes.status, 201)
      const { payment } = await qrRes.json()

      const confirmRes = await fetch(`${base}/payments/${payment.id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      })
      assert.equal(confirmRes.status, 200)

      const leaveRes = await fetch(`${base}/activities/${soloAct.id}/members/me`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      })
      assert.equal(leaveRes.status, 204)

      const enriched = (await (await fetch(`${base}/payments/${payment.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })).json()).payment
      assert.equal(enriched.refundPolicy, 'full_refund')
      assert.equal(enriched.refundAmount, 50000)
      assert.equal(enriched.penaltyPercent, 0)
    })

    await t.test('<= 6h late leave enforces reason, 20% penalty, or business approval for 100% refund', async () => {
      await db.collection('users').updateOne({ id: host.id }, { $set: { role: 'business', email_verified: true } })
      const bizToken = newToken()
      await authRepo.createSession({ tokenHash: hashToken(bizToken), userId: host.id, expiresAt: new Date(Date.now() + 86400000) })

      const mA = await authRepo.createUser({ email: 'late-a@example.com', name: 'Late A', passwordHash: 'hash' })
      const mB = await authRepo.createUser({ email: 'late-b@example.com', name: 'Late B', passwordHash: 'hash' })
      await db.collection('users').updateMany({ id: { $in: [mA.id, mB.id] } }, { $set: { email_verified: true } })
      const tokA = newToken()
      const tokB = newToken()
      await authRepo.createSession({ tokenHash: hashToken(tokA), userId: mA.id, expiresAt: new Date(Date.now() + 86400000) })
      await authRepo.createSession({ tokenHash: hashToken(tokB), userId: mB.id, expiresAt: new Date(Date.now() + 86400000) })

      const lateAct = await activityRepo.create({
        organizerType: 'business',
        depositAmount: 50000,
        estimatedCost: 150000,
        maxParticipants: 5,
        startsAt: new Date(Date.now() + 2 * 3600000),
        endsAt: new Date(Date.now() + 4 * 3600000),
        categories: ['Workshop'],
        location: 'TP. Hồ Chí Minh',
        title: 'Late Leave 6h Policy Test',
        description: 'Test <= 6h late leave rules',
      }, host)
      await db.collection('activities').updateOne(
        { id: lateAct.id },
        {
          $set: {
            status: 'published',
            memberCount: 2,
            joinRequests: [
              { id: 'jr-a', userId: mA.id, name: mA.name, status: 'approved', createdAt: new Date() },
              { id: 'jr-b', userId: mB.id, name: mB.name, status: 'approved', createdAt: new Date() },
            ],
          },
        }
      )

      const payA = (await (await fetch(`${base}/payments/create-qr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokA}` },
        body: JSON.stringify({ activityId: lateAct.id }),
      })).json()).payment
      await fetch(`${base}/payments/${payA.id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokA}` },
        body: JSON.stringify({}),
      })

      const payB = (await (await fetch(`${base}/payments/create-qr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokB}` },
        body: JSON.stringify({ activityId: lateAct.id }),
      })).json()).payment
      await fetch(`${base}/payments/${payB.id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokB}` },
        body: JSON.stringify({}),
      })

      const noReasonRes = await fetch(`${base}/activities/${lateAct.id}/members/me`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokA}` },
        body: JSON.stringify({}),
      })
      assert.equal(noReasonRes.status, 400)

      const noConfirmRes = await fetch(`${base}/activities/${lateAct.id}/members/me`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokA}` },
        body: JSON.stringify({ reason: 'Kẹt xe đột xuất' }),
      })
      assert.equal(noConfirmRes.status, 409)
      assert.equal((await noConfirmRes.json()).code, 'LATE_LEAVE_REQUIRES_CONFIRM_OR_APPROVAL')

      const penaltyLeaveRes = await fetch(`${base}/activities/${lateAct.id}/members/me`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokA}` },
        body: JSON.stringify({ reason: 'Kẹt xe đột xuất', acceptPenalty: true }),
      })
      assert.equal(penaltyLeaveRes.status, 204)
      const enrichedA = (await (await fetch(`${base}/payments/${payA.id}`, {
        headers: { Authorization: `Bearer ${tokA}` },
      })).json()).payment
      assert.equal(enrichedA.refundPolicy, 'partial_refund_80')
      assert.equal(enrichedA.penaltyPercent, 20)
      assert.equal(enrichedA.refundAmount, 40000)

      const reqLeaveRes = await fetch(`${base}/activities/${lateAct.id}/leave-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokB}` },
        body: JSON.stringify({ reason: 'Ốm đột xuất cần về' }),
      })
      assert.equal(reqLeaveRes.status, 201)
      const { request } = await reqLeaveRes.json()

      const groupBefore = await db.collection('activities').findOne({ id: lateAct.id })
      const approveRes = await fetch(`${base}/portal/groups/${lateAct.id}/leave-requests/${request.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bizToken}` },
        body: JSON.stringify({ version: groupBefore.version || 1, status: 'approved' }),
      })
      assert.equal(approveRes.status, 200)
      const enrichedB = (await (await fetch(`${base}/payments/${payB.id}`, {
        headers: { Authorization: `Bearer ${tokB}` },
      })).json()).payment
      assert.equal(enrichedB.refundPolicy, 'full_refund')
      assert.equal(enrichedB.penaltyPercent, 0)
      assert.equal(enrichedB.refundAmount, 50000)
    })

    await t.test('business kick member preserves 100% deposit refund', async () => {
      await db.collection('users').updateOne({ id: host.id }, { $set: { role: 'business', email_verified: true } })
      const bizToken = newToken()
      await authRepo.createSession({ tokenHash: hashToken(bizToken), userId: host.id, expiresAt: new Date(Date.now() + 86400000) })

      const mC = await authRepo.createUser({ email: 'kick-c@example.com', name: 'Kick C', passwordHash: 'hash' })
      await db.collection('users').updateOne({ id: mC.id }, { $set: { email_verified: true } })
      const tokC = newToken()
      await authRepo.createSession({ tokenHash: hashToken(tokC), userId: mC.id, expiresAt: new Date(Date.now() + 86400000) })

      const kickAct = await activityRepo.create({
        organizerType: 'business',
        depositAmount: 50000,
        estimatedCost: 150000,
        maxParticipants: 5,
        startsAt: new Date(Date.now() + 2 * 3600000),
        endsAt: new Date(Date.now() + 4 * 3600000),
        categories: ['Workshop'],
        location: 'TP. Hồ Chí Minh',
        title: 'Kick Member Refund Test',
        description: 'Test business kick member refund',
      }, host)
      await db.collection('activities').updateOne(
        { id: kickAct.id },
        {
          $set: {
            status: 'published',
            memberCount: 2,
            joinRequests: [{ id: 'jr-c', userId: mC.id, name: mC.name, status: 'approved', createdAt: new Date() }],
          },
        }
      )

      const payC = (await (await fetch(`${base}/payments/create-qr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokC}` },
        body: JSON.stringify({ activityId: kickAct.id }),
      })).json()).payment
      await fetch(`${base}/payments/${payC.id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokC}` },
        body: JSON.stringify({}),
      })

      const groupBefore = await db.collection('activities').findOne({ id: kickAct.id })
      const kickRes = await fetch(`${base}/portal/groups/${kickAct.id}/members/${mC.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bizToken}` },
        body: JSON.stringify({ version: groupBefore.version || 1, reason: 'Không phù hợp lịch trình' }),
      })
      assert.equal(kickRes.status, 200)

      const escrowC = await db.collection('finance_escrows').findOne({ _id: kickAct.id })
      const lotC = escrowC.lots.find(l => l.paymentId === payC.id)
      assert.equal(lotC.removedByHost, true)
      assert.equal(lotC.penaltyPercent, 0)
      assert.equal(lotC.refundableAmount, 50000)
    })
  } finally {
    server.close()
    await client.close()
    await mongo.stop()
  }
})
