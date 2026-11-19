import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { hashToken, newToken } from '../src/modules/auth/token.js'
import { crc16Ccitt } from '../src/modules/payment/vietqr.js'

test('single-confirmation manual QR payouts and private image receipts', async t => {
  const mongo = await MongoMemoryServer.create(), client = createClient(readConfig({ MONGODB_URI: mongo.getUri('manual_payouts') }))
  let server
  try {
    await client.connect(); const db = client.db(); await initializeDatabase(db)
    const auth = createAuthRepository(db), finance = auth.finance, users = [], tokens = []
    for (let i = 0; i < 4; i++) {
      const user = await auth.createUser({ name: `Payout ${i}`, email: `payout${i}@example.com`, passwordHash: 'unused' }); users.push(user)
      await db.collection('users').updateOne({ id: user.id }, { $set: { role: i < 2 ? 'admin' : 'user', email_verified: true } })
      const token = newToken(); tokens.push(token); await auth.createSession({ userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600000) })
    }
    const bank = { bankId: 'MB', accountNo: '1234567890', accountName: 'DEMO BUSINESS' }
    const make = async (status = 'pending') => {
      const id = randomUUID(), payoutId = randomUUID(), date = new Date(Date.now() - 5 * 86400000)
      const payout = { id: payoutId, ownerId: users[2].id, referenceCode: 'PO' + id.slice(0, 8).toUpperCase(), amount: 45000, grossAmount: 50000, feeAmount: 5000, bankAccount: bank, status, lotIds: ['payment-' + id], createdAt: new Date(), ...(status === 'processing' ? { transferStartedBy: users[0].id } : {}) }
      await db.collection('activities').insertOne({ id, hostId: users[2].id, title: 'Payout workshop', status: 'completed', startsAt: date, endsAt: date, completedAt: date })
      await db.collection('payments').insertOne({ id: 'payment-' + id, orderCode: 'GM' + id.replace(/-/g, ''), activityId: id, userId: users[3].id, status: 'paid', amount: 50000, createdAt: new Date() })
      await db.collection('finance_escrows').insertOne({ _id: id, activityId: id, ownerId: users[2].id, title: 'Payout workshop', version: 0, updatedAt: new Date(), audit: [], settlement: { status: 'approved' }, payouts: [payout], lots: [{ paymentId: 'payment-' + id, userId: users[3].id, amount: 50000, state: 'payout_reserved', payoutId, startsAt: date, endsAt: date, holdHours: 48, confirmation: { status: 'attended' } }] })
      return { id, payoutId, payout, path: `/api/portal/finance/groups/${id}/payouts/${payoutId}` }
    }
    const image = async color => ({ name: 'bill.png', mime: 'image/png', base64: (await sharp({ create: { width: 80, height: 120, channels: 3, background: color } }).png().toBuffer()).toString('base64') })
    const receipt = await image('#aabbcc'), otherReceipt = await image('#ddeeff')
    server = createApp(readConfig({}), { authRepository: auth }).listen(0, '127.0.0.1'); await once(server, 'listening')
    const base = `http://127.0.0.1:${server.address().port}`
    const call = async (who, path, method = 'GET', body) => {
      const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(who === null ? {} : { Authorization: `Bearer ${tokens[who]}` }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') }
    }
    const rejects = (fn, status = 409) => assert.rejects(fn, error => error.status === status)
    let item
    await t.test('only admins can prepare transfers or read/upload receipts', async () => {
      item = await make()
      assert.equal((await call(null, item.path + '/prepare-transfer', 'POST', {})).status, 401)
      for (const suffix of ['/prepare-transfer', '/receipt']) assert.equal((await call(2, item.path + suffix, 'POST', {})).status, 403)
      assert.equal((await call(3, item.path + '/receipt')).status, 403)
      assert.equal((await call(0, item.path + '/receipt')).status, 404)
    })
    await t.test('one confirmation atomically approves, locks and returns the frozen bank/amount QR', async () => {
      const response = await call(0, item.path + '/prepare-transfer', 'POST', {})
      assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.cache, 'no-store')
      const { payout, transfer } = response.body
      assert.equal(payout.status, 'processing'); assert.equal(payout.transferMode, 'manual-qr')
      assert.equal(payout.approvedBy, users[0].id); assert.equal(payout.transferStartedBy, users[0].id)
      const url = new URL(transfer.qrImageUrl)
      assert.equal(url.pathname, '/image/970422-1234567890-compact2.png'); assert.equal(url.searchParams.get('amount'), '45000')
      assert.equal(url.searchParams.get('addInfo'), item.payout.referenceCode); assert.equal(url.searchParams.get('accountName'), bank.accountName)
      assert.equal(transfer.qrPayload.slice(-4), crc16Ccitt(transfer.qrPayload.slice(0, -4)))
      assert.ok(transfer.qrPayload.includes('1234567890')); assert.ok(transfer.qrPayload.includes('540545000'))
      const summary = (await finance.dashboard(users[0].id)).summary
      assert.equal(summary.businessPaid, 0); assert.equal(summary.feeRevenue, 0); assert.equal(summary.held, 50000)
      const version = (await db.collection('finance_escrows').findOne({ _id: item.id })).version
      assert.deepEqual((await call(0, item.path + '/transfer')).body.transfer, transfer)
      assert.equal((await db.collection('finance_escrows').findOne({ _id: item.id })).version, version, 'resume is read-only')
      assert.deepEqual((await finance.preparePayoutTransfer(users[0].id, item.id, item.payoutId)).transfer, transfer)
      assert.equal((await db.collection('finance_escrows').findOne({ _id: item.id })).audit.length, 1)
    })
    await t.test('locked transfers cannot be completed without a bill or bypassed with the legacy complete action', async () => {
      assert.equal((await call(0, item.path + '/receipt', 'POST', {})).status, 400)
      await rejects(() => finance.reviewPayout(users[0].id, item.id, item.payoutId, { action: 'complete', note: 'Legacy completion bypass', transferRef: 'BYPASS-0001' }), 400)
      assert.equal((await call(1, item.path + '/transfer')).status, 409)
      await rejects(() => finance.preparePayoutTransfer(users[1].id, item.id, item.payoutId))
      await rejects(() => finance.confirmParticipation('payment-' + item.id, users[3].id, 'disputed', 'New claim during transfer'))
      await rejects(() => finance.requestRefund('payment-' + item.id, users[3].id, { ...bank, reason: 'Refund requested during bank transfer' }))
    })
    await t.test('invalid/mismatched/oversized images leave the payout locked and uncompleted', async () => {
      for (const bad of [null, { ...receipt, base64: Buffer.from('not an image').toString('base64') }, { ...receipt, name: 'bill.jpg', mime: 'image/jpeg' }, { ...receipt, name: '../bill.png' }, { ...receipt, base64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') }]) {
        await rejects(() => finance.completePayoutWithReceipt(users[0].id, item.id, item.payoutId, { receipt: bad }), 400)
      }
      assert.equal(await db.collection('finance_receipts').countDocuments(), 0)
      assert.equal((await db.collection('finance_escrows').findOne({ _id: item.id })).payouts[0].status, 'processing')
    })
    await t.test('a validated bill completes once, is stored privately, and recognizes only the net amount and fee', async () => {
      const result = await call(0, item.path + '/receipt', 'POST', { receipt })
      assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.status, 'completed')
      assert.equal(result.body.proofMethod, 'manual-bank-receipt'); assert.ok(result.body.processedAt); assert.ok(!result.body.transferRef)
      assert.ok(!result.body.receipt.base64)
      const row = await db.collection('finance_escrows').findOne({ _id: item.id })
      assert.equal(row.lots[0].state, 'settled'); assert.equal(row.audit.filter(entry => entry.action === 'payout-complete').length, 1)
      const summary = (await finance.dashboard(users[0].id)).summary
      assert.equal(summary.businessPaid, 45000); assert.equal(summary.feeRevenue, 5000); assert.equal(summary.held, 0)
      const file = await call(1, item.path + '/receipt')
      assert.equal(file.status, 200); assert.equal(file.cache, 'no-store'); assert.equal(file.body.mime, 'image/jpeg')
      assert.equal((await sharp(Buffer.from(file.body.base64, 'base64')).metadata()).format, 'jpeg')
      assert.equal((await call(2, item.path + '/receipt')).status, 403)
      assert.equal((await call(0, item.path + '/receipt', 'POST', { receipt })).status, 200)
      await rejects(() => finance.completePayoutWithReceipt(users[0].id, item.id, item.payoutId, { receipt: otherReceipt }))
      assert.equal((await db.collection('finance_escrows').findOne({ _id: item.id })).audit.filter(entry => entry.action === 'payout-complete').length, 1)
      assert.equal(await db.collection('finance_receipts').countDocuments(), 1)
    })
    await t.test('the same bill cannot complete another payout', async () => {
      const second = await make(); await finance.preparePayoutTransfer(users[0].id, second.id, second.payoutId)
      await rejects(() => finance.completePayoutWithReceipt(users[0].id, second.id, second.payoutId, { receipt }))
      assert.equal((await db.collection('finance_escrows').findOne({ _id: second.id })).payouts[0].status, 'processing')
    })
    await t.test('concurrent admins and competing bill uploads never settle twice', async () => {
      const next = await make()
      const prepared = await Promise.allSettled(users.slice(0, 2).map(user => finance.preparePayoutTransfer(user.id, next.id, next.payoutId)))
      assert.equal(prepared.filter(result => result.status === 'fulfilled').length, 1)
      const winner = prepared.find(result => result.status === 'fulfilled').value.payout.transferStartedBy
      const a = await image('#123456'), b = await image('#654321')
      const completed = await Promise.allSettled([a, b].map(receipt => finance.completePayoutWithReceipt(winner, next.id, next.payoutId, { receipt })))
      assert.equal(completed.filter(result => result.status === 'fulfilled').length, 1)
      const row = await db.collection('finance_escrows').findOne({ _id: next.id })
      assert.equal(row.payouts[0].status, 'completed'); assert.equal(row.audit.filter(entry => entry.action === 'payout-complete').length, 1)
      assert.equal((await finance.dashboard(users[0].id)).summary.businessPaid, 90000)
    })
    await t.test('business bank edits do not change an existing payout QR; approved and legacy processing payouts can continue', async () => {
      const next = await make('approved')
      await db.collection('business_bank_accounts').insertOne({ ownerId: users[2].id, ...bank, accountNo: '9999999999' })
      assert.equal((await finance.preparePayoutTransfer(users[0].id, next.id, next.payoutId)).transfer.bankAccount.accountNo, '1234567890')
      const legacy = await make('processing')
      const proof = await image('#112233')
      assert.ok((await finance.payoutTransferDetails(users[0].id, legacy.id, legacy.payoutId)).transfer.qrImageUrl)
      assert.equal((await finance.completePayoutWithReceipt(users[0].id, legacy.id, legacy.payoutId, { receipt: proof })).status, 'completed')
    })
    await t.test('self-payouts, unfinished activities, disputes and unsupported banks stay blocked', async () => {
      for (const change of ['unfinished', 'disputed', 'settlement', 'bank', 'owner']) {
        const next = await make()
        if (change === 'unfinished') await db.collection('activities').updateOne({ id: next.id }, { $set: { status: 'published' } })
        if (change === 'disputed') await db.collection('finance_escrows').updateOne({ _id: next.id }, { $set: { 'lots.0.state': 'disputed' } })
        if (change === 'settlement') await db.collection('finance_escrows').updateOne({ _id: next.id }, { $set: { 'settlement.status': 'waiting' } })
        if (change === 'bank') await db.collection('finance_escrows').updateOne({ _id: next.id }, { $set: { 'payouts.0.bankAccount.bankId': 'UNKNOWN' } })
        if (change === 'owner') await db.collection('finance_escrows').updateOne({ _id: next.id }, { $set: { ownerId: users[0].id } })
        await rejects(() => finance.preparePayoutTransfer(users[0].id, next.id, next.payoutId), change === 'owner' ? 403 : change === 'bank' ? 400 : 409)
        assert.equal((await db.collection('finance_escrows').findOne({ _id: next.id })).payouts[0].status, 'pending')
      }
      const next = await make()
      await rejects(() => finance.completePayoutWithReceipt(users[0].id, next.id, next.payoutId, { receipt: otherReceipt }))
    })
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await client.close(); await mongo.stop() }
})
