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
    assert.match(orderCode, /^GM\d{6}$/)

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
      assert.match(data.payment.orderCode, /^GM\d{6}$/)
      assert.equal(data.payment.bank.accountNo, '0901234567')

      paymentId = data.payment.id
      orderCode = data.payment.orderCode
    })

    await t.test('GET /api/payments/:id/status polls status', async () => {
      const res = await fetch(`${base}/payments/${paymentId}/status`)
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: `CHUYEN TIEN ${orderCode} COC GOMATE`,
          amount: 50000,
          transactionRef: 'FT2412345678',
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
  } finally {
    server.close()
    await client.close()
    await mongo.stop()
  }
})
