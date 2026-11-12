import { createHash, randomUUID } from 'node:crypto'
import { HttpError } from '../../common/http-error.js'
import { createFinanceRepository } from './finance.js'
import { financePolicy } from './policy.js'

export function createPaymentRepository(db, community) {
  const payments = db.collection('payments'), activities = db.collection('activities'), events = db.collection('bank_events')
  const finance = createFinanceRepository(db), policy = financePolicy()
  const amountValue = amount => { if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1000000000) throw new HttpError(400, 'Số tiền ngân hàng phải là số nguyên VND từ 1 đến 1 tỷ.'); return amount }
  async function recordIncoming(paymentId, { transactionRef, amount, confirmedBy, method, evidence = '' }) {
    amountValue(amount)
    if (!['admin-bank-reconciliation', 'bank-webhook', 'vietqr-auto-confirm'].includes(method)) throw new HttpError(403, 'Phương thức xác nhận thanh toán không hợp lệ.')
    if (typeof transactionRef !== 'string' || !/^[\w./:-]{6,120}$/.test(transactionRef)) throw new HttpError(400, 'Cần mã giao dịch ngân hàng hợp lệ (6–120 ký tự).')
    const reference = transactionRef.trim().toUpperCase(), eventId = createHash('sha256').update(reference).digest('hex')
    try { await events.insertOne({ _id: eventId, id: eventId, transactionRef: reference, amount, paymentId: paymentId || null, source: method, actorId: confirmedBy, evidence, applied: false, createdAt: new Date() }) }
    catch (error) { if (error.code !== 11000) throw error }
    const bankEvent = await events.findOne({ _id: eventId })
    if (bankEvent.amount !== amount || paymentId && bankEvent.paymentId !== paymentId) throw new HttpError(409, 'Mã giao dịch đã dùng với khoản tiền hoặc lệnh khác.')
    if (!paymentId) return { unmatched: true, eventId }
    const original = await payments.findOne({ id: paymentId })
    if (!original) throw new HttpError(404, 'Không tìm thấy giao dịch.')
    if (bankEvent.applied) return payments.findOne({ id: bankEvent.creditedPaymentId })
    const activity = original.activityId ? await activities.findOne({ id: original.activityId }) : null
    const stale = !['pending', 'paid'].includes(original.status) || amount !== original.amount || !activity || activity.organizerType !== 'business' || activity.businessRevoked || activity.status !== 'published' || new Date(activity.startsAt) <= new Date() || !activity.joinRequests?.some(member => member.userId === original.userId && member.status === 'approved') || amount !== (activity.depositAmount ?? activity.business?.depositAmount ?? 0) || new Date(original.expiresAt) <= new Date()
    const verification = { eventId, source: bankEvent.source, actorId: bankEvent.actorId, evidence: bankEvent.evidence, transactionRef: reference, amount, verifiedAt: new Date() }
    let credited = await payments.findOneAndUpdate({ id: paymentId, verification: { $exists: false }, status: { $in: ['pending', 'cancelled', 'expired', 'paid'] } }, { $set: { status: 'paid', receivedAmount: amount, paidAt: new Date(), verification, transactionRef: reference, confirmedBy, refundOnly: stale, updatedAt: new Date() } }, { returnDocument: 'after' })
    if (!credited) {
      const existing = await payments.findOne({ id: paymentId })
      if (existing.verification?.eventId === eventId) credited = existing
      else {
        const id = `extra-${eventId}`, { _id, activeKey, ...base } = original
        await payments.updateOne({ id }, { $setOnInsert: { ...base, id, orderCode: `${original.orderCode}-EXTRA-${eventId.slice(0, 8)}`, originalPaymentId: paymentId, status: 'paid', amount, receivedAmount: amount, paidAt: new Date(), verification, transactionRef: reference, refundOnly: true, financeSynced: false, createdAt: new Date(), updatedAt: new Date() } }, { upsert: true })
        credited = await payments.findOne({ id })
      }
    }
    await finance.synchronizePayment(credited)
    await events.updateOne({ _id: eventId }, { $set: { applied: true, creditedPaymentId: credited.id } })
    await community?.notify(credited.userId, { key: `bank-credit:${eventId}`, type: 'activity', title: credited.refundOnly ? 'Đã nhận tiền, cần đối soát hoàn trả' : 'Tiền cọc đã được đối soát', text: `${amount.toLocaleString('vi-VN')}đ · ${credited.activityTitle || credited.orderCode}`, activityId: credited.activityId }).catch(() => {})
    return credited
  }
  return {
    async createPayment(data) {
      amountValue(data.amount)
      const now = new Date(), activity = data.activityId ? await activities.findOne({ id: data.activityId }) : null
      const activeKey = data.type === 'activity_deposit' ? `${data.activityId}:${data.userId}` : undefined
      const payment = { ...data, id: randomUUID(), ...(activeKey ? { activeKey } : {}), status: 'pending', transactionRef: null, confirmedBy: null, paidAt: null, createdAt: now, updatedAt: now, expiresAt: data.expiresAt || new Date(Date.now() + 86400000), policy, activityStartsAt: activity?.startsAt, activityEndsAt: activity?.endsAt, cancellationDeadline: activity?.startsAt ? new Date(+new Date(activity.startsAt) - policy.freeCancellationHours * 3600000) : null }
      try { await payments.insertOne(payment); return payment }
      catch (error) { if (error.code === 11000 && activeKey) { const existing = await payments.findOne({ activeKey }); if (existing) return existing } throw error }
    },
    findPaymentById: id => payments.findOne({ id }),
    findPaymentByOrderCode: orderCode => payments.findOne({ orderCode: String(orderCode || '').trim().toUpperCase() }),
    async findPendingPayment({ userId, activityId, type }) {
      await payments.updateMany({ userId, activityId, type, status: 'pending', expiresAt: { $lte: new Date() } }, { $set: { status: 'expired' }, $unset: { activeKey: '' } })
      await payments.updateMany({ userId, activityId, type, status: { $in: ['cancelled', 'expired', 'refunded'] }, activeKey: { $exists: true } }, { $unset: { activeKey: '' } })
      return payments.findOne({ userId, activityId, type, status: 'pending', expiresAt: { $gt: new Date() } })
    },
    listUserPayments: (userId, { page = 1, limit = 20 } = {}) => finance.userWallet(userId, page, limit),
    refundPayment: (id, userId, body) => finance.requestRefund(id, userId, body),
    async reportPayment(id, userId) {
      const payment = await payments.findOneAndUpdate({ id, userId, status: 'pending' }, { $set: { reportedAt: new Date(), updatedAt: new Date() } }, { returnDocument: 'after' })
      if (!payment) { const current = await payments.findOne({ id, userId }); if (!current) throw new HttpError(404, 'Không tìm thấy giao dịch của bạn.'); return current }
      return payment
    },
    async confirmPayment(idOrOrderCode, data = {}) {
      const payment = await payments.findOne(String(idOrOrderCode).startsWith('GM') ? { orderCode: idOrOrderCode } : { id: idOrOrderCode })
      if (!payment) throw new HttpError(404, 'Không tìm thấy giao dịch.')
      if (payment.status === 'paid' && payment.verification && !data.transactionRef) return payment
      const method = data.method || 'vietqr-auto-confirm'
      const amount = data.amount ?? payment.amount
      const transactionRef = data.transactionRef || `AUTO-${payment.orderCode}-${Date.now().toString().slice(-6)}`
      return recordIncoming(payment.id, { amount, transactionRef, confirmedBy: data.confirmedBy || payment.userId, method, evidence: data.evidence || 'Xác nhận thanh toán VietQR tự động' })
    },
    recordIncoming,
    async assignIncoming(eventId, orderCode, actorId) {
      const event = await events.findOne({ _id: eventId }), payment = await payments.findOne({ orderCode })
      if (!event || !payment) throw new HttpError(404, 'Không tìm thấy khoản tiền hoặc mã thanh toán.')
      if (payment.userId === actorId) throw new HttpError(403, 'Không tự đối soát tiền vào của mình.')
      if (event.paymentId && event.paymentId !== payment.id) throw new HttpError(409, 'Khoản tiền đã được gắn với giao dịch khác.')
      await events.updateOne({ _id: eventId, paymentId: null }, { $set: { paymentId: payment.id, assignedBy: actorId, assignedAt: new Date() } })
      return recordIncoming(payment.id, { amount: event.amount, transactionRef: event.transactionRef, confirmedBy: event.actorId, method: event.source })
    },
    async reconcile() {
      for (const event of await events.find({ applied: false, paymentId: { $ne: null } }).limit(100).toArray()) await recordIncoming(event.paymentId, { amount: event.amount, transactionRef: event.transactionRef, confirmedBy: event.actorId, method: event.source })
      await finance.reconcile()
    },
    async cancelPayment(id, userId) {
      const payment = await payments.findOneAndUpdate({ id, userId, status: 'pending' }, { $set: { status: 'cancelled', updatedAt: new Date() }, $unset: { activeKey: '' } }, { returnDocument: 'after' })
      if (!payment) throw new HttpError(409, 'Chỉ hủy được giao dịch đang chờ của bạn.')
      return payment
    },
  }
}
