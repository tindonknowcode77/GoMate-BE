import { Router } from 'express'
import { authenticate } from '../../middlewares/authenticate.js'
import { HttpError } from '../../common/http-error.js'
import { buildVietQrImageUrl, buildVietQrPayload, generateOrderCode, getBankBin } from './vietqr.js'

export function createPaymentRouter(paymentRepo, authRepo, activityRepo, config) {
  const router = Router()

  const bankConfig = {
    bankId: config.vietqrBankId || 'MB',
    bankBin: config.vietqrBankBin || getBankBin(config.vietqrBankId || 'MB'),
    accountNo: config.vietqrAccountNo || '0901234567',
    accountName: config.vietqrAccountName || 'CONG TY GOMATE',
    template: config.vietqrTemplate || 'compact2',
  }

  // 1. Create QR Payment for Activity Deposit / Fee
  router.post('/create-qr', authenticate(authRepo), async (req, res) => {
    const { type = 'activity_deposit', activityId, amount } = req.body || {}
    const user = req.auth.user

    if (!['activity_deposit', 'activity_fee', 'plus_subscription', 'wallet_topup'].includes(type)) {
      throw new HttpError(400, 'Loại thanh toán không hợp lệ.')
    }

    let finalAmount = Number(amount) || 0
    let activityTitle = ''
    let activity = null

    if (type === 'activity_deposit' || type === 'activity_fee') {
      if (!activityId) throw new HttpError(400, 'Thiếu activityId cho giao dịch này.')
      activity = await activityRepo.get(activityId)
      if (!activity) throw new HttpError(404, 'Không tìm thấy hoạt động.')

      activityTitle = activity.title

      if (type === 'activity_deposit') {
        const requiredDeposit = activity.depositAmount ?? activity.business?.depositAmount ?? 0
        if (requiredDeposit <= 0) {
          throw new HttpError(400, 'Hoạt động này không yêu cầu tiền cọc.')
        }

        // Check if member is approved
        const joinRequest = (activity.joinRequests ?? []).find(item => item.userId === user.id)
        if (!joinRequest || joinRequest.status !== 'approved') {
          throw new HttpError(403, 'Chỉ thành viên đã được duyệt tham gia mới có thể thanh toán cọc.')
        }

        // Check if member already paid
        const alreadyPaid = (activity.businessReceipts ?? []).some(
          receipt => receipt.userId === user.id && receipt.status === 'paid'
        )
        if (alreadyPaid) {
          throw new HttpError(409, 'Bạn đã thanh toán tiền cọc cho hoạt động này rồi.')
        }

        finalAmount = requiredDeposit
      } else if (type === 'activity_fee') {
        finalAmount = finalAmount || activity.estimatedCost || 0
      }
    }

    if (finalAmount <= 0) {
      throw new HttpError(400, 'Số tiền thanh toán phải lớn hơn 0.')
    }

    // Check if user already has an active pending payment for this exact purpose
    const pending = await paymentRepo.findPendingPayment({
      userId: user.id,
      activityId,
      type,
    })

    if (pending && pending.amount === finalAmount) {
      return res.json({ payment: pending })
    }

    const orderCode = generateOrderCode()
    const description = `${orderCode} COC GOMATE`

    const qrPayload = buildVietQrPayload({
      bankBin: bankConfig.bankBin,
      accountNo: bankConfig.accountNo,
      amount: finalAmount,
      description,
    })

    const qrImageUrl = buildVietQrImageUrl({
      bankId: bankConfig.bankId,
      accountNo: bankConfig.accountNo,
      template: bankConfig.template,
      amount: finalAmount,
      description,
      accountName: bankConfig.accountName,
    })

    const payment = await paymentRepo.createPayment({
      userId: user.id,
      userName: user.name,
      type,
      activityId,
      activityTitle,
      amount: finalAmount,
      description,
      orderCode,
      bank: {
        bankId: bankConfig.bankId,
        bankBin: bankConfig.bankBin,
        accountNo: bankConfig.accountNo,
        accountName: bankConfig.accountName,
      },
      qrPayload,
      qrImageUrl,
    })

    res.status(201).json({ payment })
  })

  // 2. Get user's payment status for an activity
  router.get('/activity/:activityId/me', authenticate(authRepo), async (req, res) => {
    const { activityId } = req.params
    const user = req.auth.user

    const activity = await activityRepo.get(activityId)
    if (!activity) throw new HttpError(404, 'Không tìm thấy hoạt động.')

    const depositAmount = activity.depositAmount ?? activity.business?.depositAmount ?? 0
    const receipt = (activity.businessReceipts ?? []).find(r => r.userId === user.id)
    const isPaid = receipt?.status === 'paid'

    const pendingPayment = isPaid ? null : await paymentRepo.findPendingPayment({
      userId: user.id,
      activityId,
      type: 'activity_deposit',
    })

    res.json({
      activityId,
      activityTitle: activity.title,
      depositRequired: depositAmount > 0,
      depositAmount,
      isPaid,
      receipt: receipt || null,
      pendingPayment: pendingPayment || null,
      bankInfo: {
        bankId: bankConfig.bankId,
        accountNo: bankConfig.accountNo,
        accountName: bankConfig.accountName,
      },
    })
  })

  // 3. Status polling endpoint (can be polled every 2-3s from frontend while showing QR)
  router.get('/:id/status', async (req, res) => {
    const payment = await paymentRepo.findPaymentById(req.params.id)
    if (!payment) throw new HttpError(404, 'Không tìm thấy giao dịch.')

    res.json({
      id: payment.id,
      orderCode: payment.orderCode,
      status: payment.status,
      amount: payment.amount,
      paidAt: payment.paidAt,
    })
  })

  // 4. Get payment details
  router.get('/:id', authenticate(authRepo), async (req, res) => {
    const payment = await paymentRepo.findPaymentById(req.params.id)
    if (!payment) throw new HttpError(404, 'Không tìm thấy giao dịch.')
    if (payment.userId !== req.auth.user.id && req.auth.user.role !== 'admin') {
      throw new HttpError(403, 'Không có quyền xem giao dịch này.')
    }

    res.json({ payment })
  })

  // 5. Confirm payment (User "Tôi đã chuyển khoản" / Staff / Test simulation)
  router.post('/:id/confirm', authenticate(authRepo), async (req, res) => {
    const payment = await paymentRepo.findPaymentById(req.params.id)
    if (!payment) throw new HttpError(404, 'Không tìm thấy giao dịch.')

    const confirmed = await paymentRepo.confirmPayment(payment.id, {
      confirmedBy: req.auth.user.id,
      method: 'vietqr-manual-confirm',
    })

    res.json({
      message: 'Xác nhận thanh toán thành công.',
      payment: confirmed,
    })
  })

  // 6. Webhook for automatic bank transaction sync
  router.post('/webhook', async (req, res) => {
    const body = req.body || {}
    // Supports various webhook payloads (e.g. { content, description, orderCode, amount, transactionRef })
    const memo = String(body.content || body.description || body.orderCode || body.addInfo || body.memo || '').toUpperCase()
    const match = memo.match(/GM\d{6}/)
    const orderCode = match ? match[0] : null

    if (!orderCode) {
      return res.status(200).json({ status: 'ignored', message: 'No valid order code found in memo.' })
    }

    try {
      const confirmed = await paymentRepo.confirmPayment(orderCode, {
        transactionRef: body.transactionRef || body.reference || body.id || null,
        confirmedBy: 'bank-webhook',
        method: 'vietqr-webhook',
      })
      return res.json({ status: 'ok', payment: confirmed })
    } catch (error) {
      if (error.status === 404) {
        return res.status(200).json({ status: 'ignored', message: 'Order code not found in database.' })
      }
      throw error
    }
  })

  // 7. Cancel pending payment
  router.delete('/:id', authenticate(authRepo), async (req, res) => {
    const payment = await paymentRepo.cancelPayment(req.params.id, req.auth.user.id)
    res.json({ message: 'Đã hủy giao dịch.', payment })
  })

  return router
}

