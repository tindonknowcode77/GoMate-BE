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
      const [rawItems, total, allUserPayments] = await Promise.all([
        payments.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
        payments.countDocuments(query),
        payments.find(query).toArray(),
      ])

      const activityIds = [...new Set( allUserPayments.map(p => p.activityId).filter(Boolean) )]
      const activityRows = activityIds.length
        ? await activities.find({ id: { $in: activityIds } }, { projection: { id: 1, status: 1, title: 1, startsAt: 1, joinRequests: 1 } }).toArray()
        : []
      const activityMap = new Map(activityRows.map(a => [a.id, a]))

      const enrich = (p) => {
        const act = p.activityId ? activityMap.get(p.activityId) : null
        const activityStatus = act?.status || null
        const refundEligible = p.status === 'paid' && (
          p.type === 'wallet_topup' || Boolean(act?.joinRequests?.some(item => item.userId === userId && item.status !== 'approved')) ||
          ['cancelled', 'expired', 'published'].includes(activityStatus)
        )
        return {
          ...p,
          activityStatus,
          refundEligible,
        }
      }

      const items = rawItems.map(enrich)
      const enrichedAll = allUserPayments.map(enrich)

      const summary = {
        totalPaid: enrichedAll.filter(p => p.status === 'paid').reduce((s, p) => s + (p.amount || 0), 0),
        refundableAmount: enrichedAll.filter(p => p.refundEligible).reduce((s, p) => s + (p.amount || 0), 0),
        refundedAmount: enrichedAll.filter(p => p.status === 'refunded').reduce((s, p) => s + (p.amount || 0), 0),
        pendingCount: enrichedAll.filter(p => p.status === 'pending').length,
      }

      return {
        items,
        summary,
        total,
        page,
        limit,
        hasMore: skip + items.length < total,
      }
    },

    async refundPayment(id, userId, { bankId = 'BIDV', accountNo = '', accountName = '', reason = '' } = {}) {
      const payment = await payments.findOne({ id })
      if (!payment) throw new HttpError(404, 'Không tìm thấy giao dịch.')
      if (payment.userId !== userId) throw new HttpError(403, 'Không có quyền yêu cầu hoàn tiền cho giao dịch này.')
      if (payment.status === 'refunded') return payment
      if (payment.status !== 'paid') throw new HttpError(400, 'Chỉ giao dịch đã thanh toán mới có thể hoàn tiền.')

      if (payment.activityId) {
        const activity = await activities.findOne({ id: payment.activityId })
        if (activity && ['in-progress', 'completed'].includes(activity.status) && !activity.joinRequests?.some(item => item.userId === userId && item.status !== 'approved')) {
          throw new HttpError(409, 'Hoạt động đang diễn ra hoặc đã hoàn thành, không thể hoàn tiền cọc tự động.')
        }
      }

      const now = new Date()
      const refundCode = `RF${Math.floor(100000 + Math.random() * 900000)}`
      const refundInfo = {
        refundCode,
        bankId: String(bankId || 'BIDV').trim().toUpperCase(),
        accountNo: String(accountNo || '').trim(),
        accountName: String(accountName || '').trim().toUpperCase(),
        reason: String(reason || 'Hoàn trả tiền cọc theo yêu cầu').trim(),
        refundedAt: now,
      }

      await payments.updateOne(
        { id: payment.id },
        {
          $set: {
            status: 'refunded',
            refundedAt: now,
            refundInfo,
            updatedAt: now,
          },
        }
      )

      if (payment.activityId) {
        const activity = await activities.findOne({ id: payment.activityId })
        if (activity) {
          const updatedReceipts = (activity.businessReceipts ?? []).map(r =>
            r.userId === payment.userId ? { ...r, status: 'refunded', refundedAt: now, refundCode } : r
          )
          await activities.updateOne(
            { id: activity.id },
            { $set: { businessReceipts: updatedReceipts, ...(activity.status === 'published' ? { scheduleConfirmedAt: null, scheduleConfirmedBy: null } : {}), updatedAt: now } }
          )
        }
      }

      if (community?.notify) {
        await community.notify(payment.userId, {
          key: `deposit-refunded:${payment.id}:${refundCode}`,
          type: 'activity',
          title: 'Đã hoàn tiền cọc thành công',
          text: `Đã hoàn ${payment.amount.toLocaleString('vi-VN')}đ (${refundCode}) về tài khoản ${refundInfo.bankId} ${refundInfo.accountNo || ''}`.trim(),
          activityId: payment.activityId,
          actorId: payment.userId,
        }).catch(() => {})
      }

      return {
        ...payment,
        status: 'refunded',
        refundedAt: now,
        refundInfo,
      }
    },

    async confirmPayment(idOrOrderCode, { transactionRef = null, confirmedBy = 'vietqr-gateway', method = 'vietqr' } = {}) {
      const query = typeof idOrOrderCode === 'string' && idOrOrderCode.startsWith('GM')
        ? { orderCode: idOrOrderCode }
        : { id: idOrOrderCode }

      const payment = await payments.findOne(query)
      if (!payment) throw new HttpError(404, 'Không tìm thấy thông tin giao dịch.')
      if (payment.status === 'paid') return payment // Idempotent

      if (payment.status !== 'pending') throw new HttpError(409, 'Giao dịch không còn hiệu lực. Vui lòng tạo lại mã thanh toán.')
      if (payment.type === 'activity_deposit' && payment.activityId) {
        const current = await activities.findOne({ id: payment.activityId })
        if (current && payment.amount !== (current.depositAmount ?? current.business?.depositAmount ?? 0)) throw new HttpError(409, 'Mức cọc đã thay đổi. Vui lòng tạo lại mã thanh toán.')
      }

      const now = new Date()
      const confirmed = await payments.updateOne(
        { id: payment.id, status: 'pending' },
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

      if (!confirmed.matchedCount) {
        const latest = await payments.findOne({ id: payment.id })
        if (latest?.status === 'paid') return latest
        throw new HttpError(409, 'Giao dịch đã thay đổi. Vui lòng tải lại.')
      }

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

