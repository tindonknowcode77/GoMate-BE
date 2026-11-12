import { timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { authenticate } from '../../middlewares/authenticate.js'
import { HttpError } from '../../common/http-error.js'
import { fields } from '../portal/validation.js'
import { buildVietQrImageUrl, buildVietQrPayload, generateOrderCode, getBankBin } from './vietqr.js'

export function createPaymentRouter(paymentRepo, authRepo, activityRepo, config) {
  const router = Router(), auth = authenticate(authRepo)
  const writes = rateLimit({ windowMs: 60000, limit: 30, keyGenerator: req => req.auth.user.id, standardHeaders: 'draft-8', legacyHeaders: false })
  const bank = { bankId: config.vietqrBankId, bankBin: config.vietqrBankBin || getBankBin(config.vietqrBankId), accountNo: config.vietqrAccountNo, accountName: config.vietqrAccountName }
  router.post('/webhook', async (req, res) => {
    const secret = config.paymentWebhookSecret
    if (!secret || secret.length < 32) throw new HttpError(503, 'Chưa cấu hình webhook ngân hàng an toàn.')
    const supplied = req.get('x-gomate-webhook-secret') || ''
    if (Buffer.byteLength(supplied) !== Buffer.byteLength(secret) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(secret))) throw new HttpError(401, 'Webhook không được xác thực.')
    const body = req.body || {}
    if (body.direction !== 'in' || String(body.accountNo || '') !== bank.accountNo) throw new HttpError(400, 'Webhook phải là tiền vào đúng tài khoản thụ hưởng.')
    const memo = String(body.content || body.description || body.orderCode || '').toUpperCase()
    const orderCode = memo.match(/\bGM(?:\d{12}|\d{6})\b/)?.[0]
    const payment = orderCode ? await paymentRepo.findPaymentByOrderCode(orderCode) : null
    const result = await paymentRepo.recordIncoming(payment?.id || null, { amount: body.amount, transactionRef: body.transactionRef, confirmedBy: 'bank-webhook', method: 'bank-webhook' })
    res.json({ status: result.unmatched ? 'unmatched' : 'ok', ...(result.unmatched ? { eventId: result.eventId } : { payment: result }) })
  })
  router.post('/create-qr', auth, writes, async (req, res) => {
    fields(req.body, ['type', 'activityId', 'amount'])
    if ((req.body.type || 'activity_deposit') !== 'activity_deposit') throw new HttpError(400, 'Hiện chỉ nhận cọc cho hoạt động; chưa hỗ trợ nạp ví hoặc thu phí tùy ý.')
    if (typeof req.body.activityId !== 'string' || !req.body.activityId) throw new HttpError(400, 'Thiếu hoạt động thanh toán.')
    const activity = await activityRepo.get(req.body.activityId), user = req.auth.user
    if (!activity || activity.organizerType !== 'business' || activity.businessRevoked || activity.status !== 'published' || new Date(activity.startsAt) <= new Date() || activity.registrationDeadline && new Date(activity.registrationDeadline) <= new Date()) throw new HttpError(409, 'Hoạt động không còn nhận tiền cọc.')
    if (await authRepo.portal.access(activity.hostId) !== 'business') throw new HttpError(409, 'Doanh nghiệp chưa được xác minh.')
    if (!activity.joinRequests?.some(member => member.userId === user.id && member.status === 'approved')) throw new HttpError(403, 'Chỉ thành viên đã duyệt mới được thanh toán.')
    if (activity.businessReceipts?.some(receipt => receipt.userId === user.id && receipt.status === 'paid' && receipt.verified)) throw new HttpError(409, 'Bạn đã thanh toán cọc cho hoạt động này.')
    const amount = activity.depositAmount ?? activity.business?.depositAmount ?? 0
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1000000000) throw new HttpError(400, 'Mức cọc không hợp lệ hoặc không yêu cầu cọc.')
    const pending = await paymentRepo.findPendingPayment({ userId: user.id, activityId: activity.id, type: 'activity_deposit' })
    if (pending && pending.amount === amount) return res.json({ payment: pending })
    if (pending) await paymentRepo.cancelPayment(pending.id, user.id)
    for (let attempt = 0; attempt < 5; attempt++) {
      const orderCode = generateOrderCode(), description = `${orderCode} COC GOMATE`
      try {
        const payment = await paymentRepo.createPayment({ userId: user.id, userName: user.name, type: 'activity_deposit', activityId: activity.id, activityTitle: activity.title, amount, description, orderCode, bank, qrPayload: buildVietQrPayload({ ...bank, amount, description }), qrImageUrl: buildVietQrImageUrl({ ...bank, amount, description, template: config.vietqrTemplate }) })
        if (payment.status !== 'pending') throw new HttpError(409, 'Giao dịch trước đang được xử lý. Hãy kiểm tra ví.')
        return res.status(201).json({ payment })
      } catch (error) { if (error.code !== 11000) throw error }
    }
    throw new HttpError(409, 'Không tạo được mã thanh toán duy nhất. Vui lòng thử lại.')
  })
  router.get('/wallet', auth, async (req, res) => { res.set('Cache-Control', 'no-store'); res.json(await authRepo.finance.userWallet(req.auth.user.id)) })
  router.put('/wallet/bank-account', auth, writes, async (req, res) => { fields(req.body, ['bankId', 'accountNo', 'accountName', 'branch']); res.json({ bankAccount: await authRepo.finance.saveUserBank(req.auth.user.id, req.body) }) })
  router.get('/history', auth, async (req, res) => {
    const page = Number(req.query.page || 1), limit = Number(req.query.limit || 20)
    if (Object.keys(req.query).some(key => !['page', 'limit'].includes(key)) || !Number.isInteger(page) || page < 1 || page > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new HttpError(400, 'Phân trang không hợp lệ.')
    res.set('Cache-Control', 'no-store'); res.json(await paymentRepo.listUserPayments(req.auth.user.id, { page, limit }))
  })
  router.get('/activity/:activityId/me', auth, async (req, res) => {
    const activity = await activityRepo.get(req.params.activityId)
    if (!activity) throw new HttpError(404, 'Không tìm thấy hoạt động.')
    const receipt = activity.businessReceipts?.find(receipt => receipt.userId === req.auth.user.id && receipt.status === 'paid' && receipt.verified)
    const pending = receipt ? null : await paymentRepo.findPendingPayment({ userId: req.auth.user.id, activityId: activity.id, type: 'activity_deposit' })
    res.json({ activityId: activity.id, activityTitle: activity.title, depositRequired: (activity.depositAmount || 0) > 0, depositAmount: activity.depositAmount || 0, isPaid: Boolean(receipt), receipt: receipt || null, pendingPayment: pending, bankInfo: bank })
  })
  router.get('/:id/status', auth, async (req, res) => {
    const payment = await paymentRepo.findPaymentById(req.params.id)
    if (!payment || payment.userId !== req.auth.user.id && req.auth.user.role !== 'admin') throw new HttpError(404, 'Không tìm thấy giao dịch của bạn.')
    res.json({ id: payment.id, orderCode: payment.orderCode, status: payment.status, verified: Boolean(payment.verification), amount: payment.amount, paidAt: payment.paidAt, refundOnly: Boolean(payment.refundOnly) })
  })
  router.get('/:id', auth, async (req, res) => {
    const payment = await paymentRepo.findPaymentById(req.params.id)
    if (!payment || payment.userId !== req.auth.user.id && req.auth.user.role !== 'admin') throw new HttpError(404, 'Không tìm thấy giao dịch của bạn.')
    res.json({ payment: await authRepo.finance.enrich(payment) })
  })
  router.post('/:id/confirm', auth, writes, async (req, res) => {
    fields(req.body || {}, [])
    const existing = await paymentRepo.findPaymentById(req.params.id)
    if (!existing) throw new HttpError(404, 'Không tìm thấy giao dịch.')
    if (existing.userId !== req.auth.user.id && req.auth.user.role !== 'admin') throw new HttpError(403, 'Không có quyền xác nhận giao dịch này.')
    const payment = await paymentRepo.confirmPayment(req.params.id, {
      confirmedBy: req.auth.user.id,
      method: 'vietqr-auto-confirm',
    })
    res.json({ message: 'Thanh toán tiền cọc đã được xác nhận tự động.', payment })
  })
  router.post('/:id/refund', auth, writes, async (req, res) => {
    fields(req.body, ['bankId', 'accountNo', 'accountName', 'reason'])
    res.json({ message: 'Đã gửi yêu cầu hoàn tiền, đang chờ admin.', payment: await paymentRepo.refundPayment(req.params.id, req.auth.user.id, req.body) })
  })
  router.post('/:id/participation', auth, writes, async (req, res) => { fields(req.body, ['status', 'note']); res.json(await authRepo.finance.confirmParticipation(req.params.id, req.auth.user.id, req.body.status, req.body.note)) })
  router.delete('/:id', auth, writes, async (req, res) => res.json({ payment: await paymentRepo.cancelPayment(req.params.id, req.auth.user.id) }))
  return router
}
