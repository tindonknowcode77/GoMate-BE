import { randomUUID } from 'node:crypto'
import { HttpError } from '../../common/http-error.js'

export function createPaymentRepository(db, community) {
  const payments = db.collection('payments')
  const activities = db.collection('activities')

  return {
    async createPayment({ userId, userName, type, activityId = null, activityTitle = '', amount, description, orderCode, bank, qrPayload, qrImageUrl, expiresAt }) {
      const now = new Date()
      const payment = {
        id: randomUUID(),
        orderCode,
        userId,
        userName,
        type, // 'activity_deposit' | 'activity_fee' | 'plus_subscription' | 'wallet_topup'
        activityId,
        activityTitle,
        amount,
        description,
        bank, // { bankId, bankBin, accountNo, accountName }
        qrPayload,
        qrImageUrl,
        status: 'pending', // 'pending' | 'paid' | 'cancelled' | 'expired'
        transactionRef: null,
        confirmedBy: null,
        createdAt: now,
        updatedAt: now,
        paidAt: null,
        expiresAt: expiresAt || new Date(now.getTime() + 24 * 60 * 60 * 1000), // Default 24 hours
      }

      await payments.insertOne(payment)
      return payment
    },

    async findPaymentById(id) {
      return payments.findOne({ id })
    },

    async findPaymentByOrderCode(orderCode) {
      if (!orderCode) return null
      return payments.findOne({ orderCode: String(orderCode).trim().toUpperCase() })
    },

    async findPendingPayment({ userId, activityId, type }) {
      const now = new Date()
      return payments.findOne({
        userId,
        activityId,
        type,
        status: 'pending',
        expiresAt: { $gt: now },
      })
    },

    async listUserPayments(userId, { page = 1, limit = 20 } = {}) {
      const skip = (page - 1) * limit
      const query = { userId }
      const [items, total] = await Promise.all([
        payments.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
        payments.countDocuments(query),
      ])
      return {
        items,
        total,
        page,
        limit,
        hasMore: skip + items.length < total,
      }
    },

    async confirmPayment(idOrOrderCode, { transactionRef = null, confirmedBy = 'vietqr-gateway', method = 'vietqr' } = {}) {
      const query = typeof idOrOrderCode === 'string' && idOrOrderCode.startsWith('GM')
        ? { orderCode: idOrOrderCode }
        : { id: idOrOrderCode }

      const payment = await payments.findOne(query)
      if (!payment) throw new HttpError(404, 'Không tìm thấy thông tin giao dịch.')
      if (payment.status === 'paid') return payment // Idempotent

      const now = new Date()
      await payments.updateOne(
        { id: payment.id },
        {
          $set: {
            status: 'paid',
            paidAt: now,
            updatedAt: now,
            transactionRef: transactionRef || payment.transactionRef,
            confirmedBy,
          },
        }
      )

      payment.status = 'paid'
      payment.paidAt = now

      // If this is an activity deposit payment, automatically record receipt in activity
      if (payment.type === 'activity_deposit' && payment.activityId) {
        const activity = await activities.findOne({ id: payment.activityId })
        if (activity) {
          const receipt = {
            userId: payment.userId,
            status: 'paid',
            amount: payment.amount,
            paidAt: now,
            recordedBy: confirmedBy,
            recordedAt: now,
            method,
            paymentId: payment.id,
            orderCode: payment.orderCode,
          }

          const existingReceipts = (activity.businessReceipts ?? []).filter(item => item.userId !== payment.userId)
          await activities.updateOne(
            { id: activity.id },
            {
              $set: {
                businessReceipts: [...existingReceipts, receipt],
                updatedAt: now,
              },
            }
          )

          // Notify member
          if (community?.notify) {
            await community.notify(payment.userId, {
              key: `deposit-confirmed:${activity.id}:${payment.userId}:${payment.orderCode}`,
              type: 'activity',
              title: 'Thanh toán tiền cọc thành công',
              text: `${activity.title} · ${payment.amount.toLocaleString('vi-VN')}đ qua VietQR`,
              activityId: activity.id,
              actorId: payment.userId,
            }).catch(() => {})

            // Notify host
            if (activity.hostId && activity.hostId !== payment.userId) {
              await community.notify(activity.hostId, {
                key: `deposit-received:${activity.id}:${payment.userId}:${payment.orderCode}`,
                type: 'activity',
                title: 'Thành viên đã thanh toán tiền cọc',
                text: `${payment.userName || 'Thành viên'} đã thanh toán ${payment.amount.toLocaleString('vi-VN')}đ cọc cho ${activity.title}`,
                activityId: activity.id,
                actorId: payment.userId,
              }).catch(() => {})
            }
          }
        }
      }

      return payment
    },

    async cancelPayment(id, userId) {
      const payment = await payments.findOne({ id })
      if (!payment) throw new HttpError(404, 'Không tìm thấy giao dịch')
      if (payment.userId !== userId) throw new HttpError(403, 'Không có quyền hủy giao dịch này')
      if (payment.status !== 'pending') throw new HttpError(400, 'Chỉ có thể hủy giao dịch đang chờ thanh toán')

      const now = new Date()
      await payments.updateOne(
        { id },
        { $set: { status: 'cancelled', updatedAt: now } }
      )
      return { ...payment, status: 'cancelled' }
    },
  }
}

