import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { createActivityRepository } from '../src/modules/activities/repository.js'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { hashToken, newToken } from '../src/modules/auth/token.js'
import { financePolicy } from '../src/modules/payment/policy.js'
import { createBusinessOperations } from '../src/modules/portal/operations.js'

test('verified escrow: adversarial payments, refunds, disputes and admin settlement', async t => {
  const mongo = await MongoMemoryServer.create(), client = createClient(readConfig({ MONGODB_URI: mongo.getUri('finance_adverse') }))
  await client.connect(); const db = client.db(); await initializeDatabase(db)
  const auth = createAuthRepository(db), finance = auth.finance, payments = auth.payments, operations = createBusinessOperations(db), users = [], tokens = []
  const secret = 'secure-bank-adapter-secret-1234567890', bank = { bankId: 'MB', accountNo: '0901234567', accountName: 'TEST ACCOUNT' }
  for (let i = 0; i < 8; i++) {
    const user = await auth.createUser({ name: `Finance ${i}`, email: `finance${i}@example.com`, passwordHash: 'unused' }); users.push(user)
    await db.collection('users').updateOne({ id: user.id }, { $set: { role: i === 0 ? 'admin' : 'user', email_verified: true } })
    const token = newToken(); tokens.push(token); await auth.createSession({ userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600000) })
  }
  await db.collection('business_applications').insertOne({ id: 'verified-finance-business', ownerId: users[1].id, company: 'Finance Business', status: 'approved' })
  await operations.saveBankAccount(users[1].id, bank)
  for (const user of users.slice(2)) await finance.saveUserBank(user.id, bank)
  const server = createApp(readConfig({ PAYMENT_WEBHOOK_SECRET: secret, VIETQR_BANK_ID: bank.bankId, VIETQR_ACCOUNT_NO: bank.accountNo, VIETQR_ACCOUNT_NAME: bank.accountName }), { authRepository: auth, activityRepository: createActivityRepository(db) }).listen(0)
  await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}/api`
  const call = async (who, path, method = 'GET', body, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(who === null ? {} : { Authorization: `Bearer ${tokens[who]}` }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  }
  const ok = (response, status = 200) => { assert.equal(response.status, status, JSON.stringify(response.body)); return response.body }
  const rejects = (fn, status = 409) => assert.rejects(fn, error => error.status === status)
  const make = async (who = 2) => {
    const id = randomUUID(), start = new Date(Date.now() + 4 * 86400000), end = new Date(+start + 7200000)
    await db.collection('activities').insertOne({ id, hostId: users[1].id, hostName: users[1].name, title: 'Finance workshop', organizerType: 'business', status: 'published', version: 1, startsAt: start, endsAt: end, depositAmount: 50000, memberCount: 2, maxParticipants: 10, joinRequests: [{ userId: users[who].id, status: 'approved' }] })
    const payment = ok(await call(who, '/payments/create-qr', 'POST', { activityId: id }), 201).payment
    return { id, payment, who }
  }
  const incoming = async (fixture, ref = randomUUID(), amount = 50000) => payments.confirmPayment(fixture.payment.id, { method: 'admin-bank-reconciliation', confirmedBy: users[0].id, amount, transactionRef: ref, evidence: 'Bank statement checked by finance administrator' })
  const age = async fixture => {
    // Represent an originally old contract. Editing only the activity dates must not bypass the frozen ledger dates.
    const startsAt = new Date(Date.now() - 5 * 86400000), endsAt = new Date(Date.now() - 4 * 86400000)
    await db.collection('activities').updateOne({ id: fixture.id }, { $set: { status: 'completed', startsAt, endsAt, completedAt: endsAt } })
    await db.collection('finance_escrows').updateOne({ _id: fixture.id }, { $set: { 'lots.$[].startsAt': startsAt, 'lots.$[].endsAt': endsAt, 'lots.$[].cancelBefore': new Date(+startsAt - 86400000) } })
  }
  const review = fixture => finance.reviewSettlement(users[0].id, fixture.id, { evidence: 'Venue report and actual participant evidence verified', note: 'Activity verified', overrideReason: 'Administrator checked independent attendance evidence' })
  const request = (fixture, key = randomUUID()) => finance.requestPayout(users[1].id, { activityId: fixture.id, clientRequestId: key, amount: 45000, note: 'Payout request' })
  const adminReview = (fixture, payout, body) => finance.reviewPayout(users[0].id, fixture.id, payout.id, { note: 'Bank statement checked', ...body })
  try {
    let first
    await t.test('policy is explicit, bounded and configurable', () => {
      assert.equal(financePolicy({}).freeCancellationHours, 6); assert.equal(financePolicy({}).settlementHoldHours, 48)
      assert.equal(financePolicy({ PAYMENT_SETTLEMENT_HOLD_HOURS: '72' }).settlementHoldHours, 72)
      assert.throws(() => financePolicy({ PAYMENT_SETTLEMENT_HOLD_HOURS: '0' }))
    })
    await t.test('only members can pay; amount is server-derived; pending retry returns the same order', async () => {
      first = await make(); const retried = ok(await call(2, '/payments/create-qr', 'POST', { activityId: first.id, amount: 1 })).payment
      assert.equal(retried.id, first.payment.id); assert.equal(retried.amount, 50000)
      ok(await call(3, '/payments/create-qr', 'POST', { activityId: first.id }), 403)
      ok(await call(2, '/payments/create-qr', 'POST', { type: 'wallet_topup', amount: 50000 }), 400)
    })
    await t.test('auto-confirm immediately credits verified escrow and status polling is private', async () => {
      const confirmed = ok(await call(2, `/payments/${first.payment.id}/confirm`, 'POST', {})).payment
      assert.equal(confirmed.status, 'paid')
      assert.ok(confirmed.verification)
      ok(await call(null, `/payments/${first.payment.id}/status`), 401)
      ok(await call(3, `/payments/${first.payment.id}/status`), 404)
      assert.equal((await finance.dashboard(users[0].id)).summary.received, 50000)
      ok(await call(1, '/portal/finance'), 403)
    })
    await t.test('webhooks reject missing secret, wrong direction/account and fractional amounts', async () => {
      const webhookOrder = await make()
      const body = { direction: 'in', accountNo: bank.accountNo, amount: 50000, transactionRef: 'WEBHOOK-0001', content: webhookOrder.payment.orderCode }
      ok(await call(null, '/payments/webhook', 'POST', body), 401)
      const headers = { 'x-gomate-webhook-secret': secret }
      ok(await call(null, '/payments/webhook', 'POST', { ...body, direction: 'out' }, headers), 400)
      ok(await call(null, '/payments/webhook', 'POST', { ...body, accountNo: '123456789' }, headers), 400)
      ok(await call(null, '/payments/webhook', 'POST', { ...body, amount: 0.5 }, headers), 400)
      const paid = ok(await call(null, '/payments/webhook', 'POST', body, headers)).payment
      assert.equal(paid.refundOnly, false); assert.ok(paid.verification)
      assert.equal(ok(await call(2, `/payments/activity/${webhookOrder.id}/me`)).isPaid, true)
      ok(await call(null, '/payments/webhook', 'POST', body, headers))
      assert.equal((await db.collection('finance_escrows').findOne({ _id: webhookOrder.id })).lots.length, 1)
    })
    await t.test('same bank reference cannot credit another order; real second transfer is refundable, never extra merchant revenue', async () => {
      const other = await make(3)
      await rejects(() => incoming(other, 'WEBHOOK-0001'))
      const extra = await incoming(first, 'SECOND-REAL-TRANSFER')
      assert.equal(extra.refundOnly, true); assert.notEqual(extra.id, first.payment.id)
      assert.equal((await incoming(first, 'SECOND-REAL-TRANSFER')).id, extra.id)
      assert.equal((await db.collection('finance_escrows').findOne({ _id: first.id })).lots.length, 2)
    })
    await t.test('wrong amount, expired quote and canceled quote retain actual money as refund-only', async () => {
      for (const kind of ['wrong', 'expired', 'cancelled']) {
        const item = await make(4)
        if (kind === 'expired') await db.collection('payments').updateOne({ id: item.payment.id }, { $set: { expiresAt: new Date(0) } })
        if (kind === 'cancelled') await payments.cancelPayment(item.payment.id, users[4].id)
        const credit = await incoming(item, randomUUID(), kind === 'wrong' ? 49000 : 50000)
        assert.equal(credit.refundOnly, true); assert.equal(credit.receivedAmount, kind === 'wrong' ? 49000 : 50000)
        assert.equal(ok(await call(4, `/payments/activity/${item.id}/me`)).isPaid, false)
      }
    })
    await t.test('unmatched bank money is durable and can be assigned once by admin', async () => {
      const event = await payments.recordIncoming(null, { transactionRef: 'UNMATCHED-REAL-TRANSFER', amount: 50000, method: 'bank-webhook', confirmedBy: 'bank-webhook' })
      const item = await make(5)
      ok(await call(1, `/portal/finance/incoming/${event.eventId}/assign`, 'POST', { orderCode: item.payment.orderCode }), 403)
      const assigned = ok(await call(0, `/portal/finance/incoming/${event.eventId}/assign`, 'POST', { orderCode: item.payment.orderCode })).payment
      assert.equal(assigned.id, item.payment.id)
      assert.equal((await db.collection('bank_events').findOne({ _id: event.eventId })).applied, true)
    })
    await t.test('merchant start/finish plus shortened schedule cannot bypass original end and hold', async () => {
      await db.collection('activities').updateOne({ id: first.id }, { $set: { status: 'completed', startsAt: new Date(0), endsAt: new Date(1), completedAt: new Date(2) } })
      await rejects(() => request(first)); await rejects(() => review(first))
      assert.equal((await finance.businessWallet(users[1].id)).withdrawableAmount, 0)
    })
    await t.test('saved refund banks validate and request snapshots survive later bank changes', async () => {
      const item = await make(6); await incoming(item)
      await rejects(() => finance.saveUserBank(users[6].id, { ...bank, accountNo: 'abc' }), 400)
      const result = await finance.requestRefund(item.payment.id, users[6].id, { reason: 'Cannot attend anymore' })
      assert.equal(result.status, 'paid'); assert.equal(result.refundRequest.policy, 'full_refund'); assert.equal(result.financeState, 'refund_requested')
      await finance.saveUserBank(users[6].id, { ...bank, accountNo: '9999999999' })
      assert.equal((await finance.enrich(await payments.findPaymentById(item.payment.id))).refundRequest.bankAccount.accountNo, bank.accountNo)
      assert.equal((await db.collection('activities').findOne({ id: item.id })).joinRequests[0].status, 'left')
      await rejects(() => finance.reviewRefund(users[0].id, item.payment.id, { action: 'reject', note: 'Reject early full refund' }))
      await rejects(() => finance.reviewRefund(users[0].id, item.payment.id, { action: 'complete', note: 'Skip approval attempt', transferRef: 'EARLY-TRANSFER' }))
      await finance.reviewRefund(users[0].id, item.payment.id, { action: 'approve', note: 'Approved full refund' })
      assert.equal((await payments.findPaymentById(item.payment.id)).status, 'paid')
      ok(await call(0, `/portal/finance/refunds/${item.payment.id}/review`, 'POST', { action: 'complete', note: 'Bank transfer checked', transferRef: 'REFUND-PROOF-0001' }), 400)
      const completed = ok(await call(0, `/portal/finance/refunds/${item.payment.id}/review`, 'POST', { action: 'complete', note: 'Bank transfer checked', transferRef: 'REFUND-PROOF-0001', bankTransferConfirmed: true }))
      assert.equal(completed.status, 'completed'); assert.equal((await payments.findPaymentById(item.payment.id)).status, 'refunded')
      await finance.reviewRefund(users[0].id, item.payment.id, { action: 'complete', note: 'Idempotent retry proof', transferRef: 'REFUND-PROOF-0001' })
      await rejects(() => finance.reviewRefund(users[0].id, item.payment.id, { action: 'complete', note: 'Different reference retry', transferRef: 'REFUND-PROOF-0002' }))
    })
    let mature, payout
    await t.test('missing independent attendance requires a documented admin override; participant can confirm', async () => {
      mature = await make(2); await incoming(mature); await age(mature)
      await rejects(() => finance.reviewSettlement(users[0].id, mature.id, { evidence: 'Actual event evidence verified', note: 'Approved event' }), 400)
      await finance.confirmParticipation(mature.payment.id, users[2].id, 'attended')
      await finance.reviewSettlement(users[0].id, mature.id, { evidence: 'Actual event evidence verified', note: 'Approved event' })
    })
    await t.test('concurrent payout attempts cannot double-spend; same request is idempotent; bank is frozen', async () => {
      const key = randomUUID(), result = await Promise.allSettled([request(mature, key), request(mature)])
      assert.equal(result.filter(item => item.status === 'fulfilled').length, 1)
      payout = result.find(item => item.status === 'fulfilled').value.payout
      assert.equal(payout.status, 'pending'); assert.equal(payout.amount, 45000)
      assert.equal((await request(mature, payout.clientRequestId)).payout.id, payout.id)
      await operations.saveBankAccount(users[1].id, { ...bank, accountNo: '8888888888' })
      assert.equal((await request(mature, payout.clientRequestId)).payout.bankAccount.accountNo, bank.accountNo)
      await rejects(() => finance.requestPayout(users[1].id, { activityId: mature.id, clientRequestId: payout.clientRequestId, amount: 1 }))
      await rejects(() => adminReview(mature, payout, { action: 'complete', transferRef: 'PREAPPROVAL-FAIL' }))
      await adminReview(mature, payout, { action: 'approve' })
      assert.equal((await finance.businessWallet(users[1].id)).paidOutAmount, 0)
    })
    await t.test('dispute after payout approval blocks payment and requires resolution plus new settlement review', async () => {
      assert.equal((await finance.enrich(await payments.findPaymentById(mature.payment.id))).canConfirmAttendance, true)
      await finance.confirmParticipation(mature.payment.id, users[2].id, 'disputed', 'Merchant did not deliver the promised service')
      await rejects(() => adminReview(mature, payout, { action: 'complete', transferRef: 'BLOCKED-PAYOUT' }))
      const row = await db.collection('finance_escrows').findOne({ _id: mature.id }); assert.equal(row.payouts[0].status, 'blocked'); assert.equal(row.lots[0].state, 'disputed')
      await rejects(() => finance.confirmParticipation(mature.payment.id, users[2].id, 'attended'))
      await rejects(() => review(mature))
      await finance.resolveDispute(users[0].id, mature.id, mature.payment.id, 'Checked all evidence and contacted both parties; complaint resolved')
      await rejects(() => request(mature))
      await review(mature)
    })
    await t.test('refund after approval cancels payout reservation; late/no-show is reviewed, not silently forfeited', async () => {
      payout = (await request(mature)).payout; await adminReview(mature, payout, { action: 'approve' })
      const refund = await finance.requestRefund(mature.payment.id, users[2].id, { reason: 'Late cancellation needs review' })
      assert.equal(refund.refundRequest.policy, 'manual_review'); assert.equal(refund.refundRequest.status, 'pending')
      await rejects(() => adminReview(mature, payout, { action: 'complete', transferRef: 'REFUND-BLOCKS-PAYOUT' }))
      await finance.reviewRefund(users[0].id, mature.payment.id, { action: 'reject', note: 'Evidence shows service delivered; no refund granted' })
      await review(mature); payout = (await request(mature)).payout; await adminReview(mature, payout, { action: 'approve' })
    })
    await t.test('payout only completes with admin approval and recorded bank proof; replay never pays twice', async () => {
      await rejects(() => adminReview(mature, payout, { action: 'complete', transferRef: 'PAYOUT-BEFORE-LOCK' }))
      await adminReview(mature, payout, { action: 'start_transfer' })
      await rejects(() => finance.requestRefund(mature.payment.id, users[2].id, { reason: 'Refund races an actual bank transfer' }))
      await rejects(() => finance.confirmParticipation(mature.payment.id, users[2].id, 'disputed', 'Claim races bank transfer'))
      await rejects(() => adminReview(mature, payout, { action: 'reject' }))
      await rejects(() => adminReview(mature, payout, { action: 'transfer_failed', bankTransferNotSent: false }))
      await rejects(() => adminReview(mature, payout, { action: 'complete', transferRef: 'REFUND-PROOF-0001' }))
      const body = { action: 'complete', note: 'Actual bank transfer verified', transferRef: 'PAYOUT-PROOF-0001' }
      const path = `/portal/finance/groups/${mature.id}/payouts/${payout.id}/review`
      ok(await call(0, path, 'POST', body), 400)
      assert.equal(ok(await call(0, path, 'POST', { ...body, bankTransferConfirmed: true })).status, 'completed')
      assert.equal(ok(await call(0, path, 'POST', { ...body, bankTransferConfirmed: true })).status, 'completed')
      assert.equal((await finance.businessWallet(users[1].id)).paidOutAmount, 45000)
      await rejects(() => finance.requestRefund(mature.payment.id, users[2].id, { reason: 'Cannot spend this money twice' }))
      await rejects(() => request(mature))
    })
    await t.test('non-admin and financially related admin cannot approve their own money', async () => {
      await rejects(() => finance.dashboard(users[1].id), 403)
      const own = await make(0); await incoming(own); await age(own)
      await finance.requestRefund(own.payment.id, users[0].id, { ...bank, reason: 'Admin personal refund' })
      await rejects(() => finance.reviewRefund(users[0].id, own.payment.id, { action: 'approve', note: 'Attempt own approval' }), 403)
      const fixture = await make(3); await incoming(fixture); await age(fixture)
      await db.collection('users').updateOne({ id: users[1].id }, { $set: { role: 'admin' } })
      await rejects(() => finance.reviewSettlement(users[1].id, fixture.id, { evidence: 'Owner admin tries approval', note: 'Own settlement', overrideReason: 'This must not allow owner to approve itself' }), 403)
      await db.collection('users').updateOne({ id: users[1].id }, { $set: { role: 'user' } })
    })
    await t.test('worker recovery resynchronizes verified lots and refunds without duplicate receipts', async () => {
      const fixture = await make(7); const paid = await incoming(fixture)
      await db.collection('finance_escrows').deleteOne({ _id: fixture.id }); await db.collection('payments').updateOne({ id: paid.id }, { $unset: { financeSynced: '' } })
      await Promise.all([payments.reconcile(), payments.reconcile()])
      const row = await db.collection('finance_escrows').findOne({ _id: fixture.id }); assert.equal(row.lots.length, 1)
      assert.equal((await db.collection('activities').findOne({ id: fixture.id })).businessReceipts.length, 1)
      assert.ok(paid.verification.evidence.includes('Bank statement'))
      const refunded = await db.collection('payments').findOne({ status: 'refunded' })
      await db.collection('payments').updateOne({ id: refunded.id }, { $set: { status: 'paid' } })
      await db.collection('finance_escrows').updateOne({ _id: refunded.activityId }, { $set: { refundMirrorPending: true } })
      await finance.reconcile()
      assert.equal((await payments.findPaymentById(refunded.id)).status, 'refunded')
      assert.equal((await db.collection('finance_escrows').findOne({ _id: refunded.activityId })).refundMirrorPending, undefined)
    })
    await t.test('concurrent duplicate bank delivery credits exactly one lot', async () => {
      const fixture = await make(3)
      await Promise.all([incoming(fixture, 'CONCURRENT-BANK-EVENT'), incoming(fixture, 'CONCURRENT-BANK-EVENT')])
      assert.equal((await db.collection('finance_escrows').findOne({ _id: fixture.id })).lots.length, 1)
    })
    await t.test('refund racing payout creation always protects the same funds', async () => {
      const fixture = await make(4); await incoming(fixture); await age(fixture); await review(fixture)
      const results = await Promise.allSettled([request(fixture), finance.requestRefund(fixture.payment.id, users[4].id, { reason: 'Concurrent refund request' })])
      assert.equal(results[1].status, 'fulfilled')
      const row = await db.collection('finance_escrows').findOne({ _id: fixture.id })
      assert.equal(row.lots[0].state, 'refund_requested'); assert.ok(row.payouts.every(item => item.status === 'blocked'))
    })
    await t.test('uncertain bank transfers stay locked; verified transfer failure requires a fresh review', async () => {
      const fixture = await make(5); await incoming(fixture); await age(fixture); await review(fixture)
      const payout = (await request(fixture)).payout
      await adminReview(fixture, payout, { action: 'approve' }); await adminReview(fixture, payout, { action: 'start_transfer' })
      await adminReview(fixture, payout, { action: 'start_transfer' })
      await rejects(() => request(fixture))
      await adminReview(fixture, payout, { action: 'transfer_failed', bankTransferNotSent: true, note: 'Bank verified no debit or outgoing transfer on statement' })
      const row = await db.collection('finance_escrows').findOne({ _id: fixture.id }); assert.equal(row.lots[0].state, 'held'); assert.equal(row.settlement.status, 'waiting')
      await rejects(() => request(fixture)); await review(fixture)
    })
    await t.test('deleted events preserve the full refund entitlement', async () => {
      const fixture = await make(7); await incoming(fixture); await age(fixture)
      await db.collection('activities').deleteOne({ id: fixture.id })
      const refund = await finance.requestRefund(fixture.payment.id, users[7].id, { reason: 'Event no longer exists' })
      assert.equal(refund.refundRequest.policy, 'full_refund')
    })
    await t.test('admin totals balance and user history totals are independent of pagination', async () => {
      const data = ok(await call(0, '/portal/finance')), s = data.summary
      assert.equal(s.received, s.held + s.refunded + s.businessPaid + s.feeRevenue)
      assert.equal(s.businessPaid, 45000); assert.equal(s.feeRevenue, 5000); assert.equal(s.refunded, 50000)
      const a = await finance.userWallet(users[2].id, 1, 1), b = await finance.userWallet(users[2].id, 2, 1)
      assert.deepEqual(a.summary, b.summary); assert.equal(a.items.length, 1)
      ok(await call(2, '/payments/history?page=1.1'), 400)
    })
    await t.test('host kicking a paid member preserves 100% refund and admin dispute outcome=refund approves refund directly', async () => {
      const kicked = await make(6); await incoming(kicked)
      const nearStart = new Date(Date.now() + 3600000)
      await db.collection('finance_escrows').updateOne({ _id: kicked.id }, { $set: { 'lots.$[].cancelBefore': new Date(Date.now() - 3600000), 'lots.$[].startsAt': nearStart } })
      const delRes = await fetch(`${base}/activities/${kicked.id}/members/${users[6].id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tokens[1]}` } })
      assert.equal(delRes.status, 204)
      const refund = await finance.requestRefund(kicked.payment.id, users[6].id, { reason: 'Removed by host before start' })
      assert.equal(refund.refundRequest.policy, 'full_refund')
      const disputed = await make(7); await incoming(disputed); await age(disputed)
      await finance.confirmParticipation(disputed.payment.id, users[7].id, 'disputed', 'Service differed materially from confirmed itinerary')
      await finance.resolveDispute(users[0].id, disputed.id, disputed.payment.id, 'Verified participant evidence; approving full deposit refund', 'refund')
      const escrowRow = await db.collection('finance_escrows').findOne({ _id: disputed.id })
      assert.equal(escrowRow.lots[0].state, 'refund_approved')
      assert.equal(escrowRow.lots[0].refund.status, 'approved')
    })
  } finally { await new Promise(resolve => server.close(resolve)); await client.close(); await mongo.stop() }
})
