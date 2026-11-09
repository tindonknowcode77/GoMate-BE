import { Router } from 'express'
import express from 'express'
import { HttpError } from '../../common/http-error.js'
import { fields } from '../portal/validation.js'

export function createFinanceRouter(auth, writes) {
  const router = Router(), finance = auth.finance
  router.use((req, _res, next) => { if (req.portalRole !== 'admin') throw new HttpError(403, 'Chỉ admin được quản lý tài chính.'); next() })
  router.use(express.json({ limit: '32kb' }))
  router.get('/', async (req, res) => {
    const page = Number(req.query.page || 1)
    if (Object.keys(req.query).some(key => key !== 'page') || !Number.isInteger(page) || page < 1 || page > 10000) throw new HttpError(400, 'Trang không hợp lệ.')
    res.set('Cache-Control', 'no-store'); res.json(await finance.dashboard(req.auth.user.id, page))
  })
  router.post('/payments/:id/verify', writes, async (req, res) => {
    fields(req.body, ['amount', 'transactionRef', 'evidence'])
    if (typeof req.body.evidence !== 'string' || req.body.evidence.trim().length < 10 || req.body.evidence.length > 2000) throw new HttpError(400, 'Nhập bằng chứng đối soát ngân hàng (10–2000 ký tự).')
    const payment = await auth.payments.findPaymentById(req.params.id)
    if (!payment) throw new HttpError(404, 'Không tìm thấy giao dịch.')
    if (payment.userId === req.auth.user.id) throw new HttpError(403, 'Không tự xác minh tiền vào của mình.')
    res.json({ payment: await auth.payments.confirmPayment(req.params.id, { amount: req.body.amount, transactionRef: req.body.transactionRef, evidence: req.body.evidence, confirmedBy: req.auth.user.id, method: 'admin-bank-reconciliation' }) })
  })
  router.post('/incoming/:id/assign', writes, async (req, res) => {
    fields(req.body, ['orderCode'])
    if (typeof req.body.orderCode !== 'string' || !/^GM\d{6,12}$/.test(req.body.orderCode)) throw new HttpError(400, 'Mã thanh toán không hợp lệ.')
    res.json({ payment: await auth.payments.assignIncoming(req.params.id, req.body.orderCode, req.auth.user.id) })
  })
  router.post('/groups/:id/review', writes, async (req, res) => {
    fields(req.body, ['evidence', 'note', 'overrideReason'])
    res.json(await finance.reviewSettlement(req.auth.user.id, req.params.id, req.body))
  })
  router.post('/refunds/:id/review', writes, async (req, res) => {
    fields(req.body, ['action', 'note', 'transferRef', 'bankTransferConfirmed'])
    if (req.body.action === 'complete' && req.body.bankTransferConfirmed !== true) throw new HttpError(400, 'Phải xác nhận đã thực hiện chuyển tiền ngân hàng.')
    res.json(await finance.reviewRefund(req.auth.user.id, req.params.id, req.body))
  })
  router.post('/groups/:id/disputes/:paymentId', writes, async (req, res) => {
    fields(req.body, ['note', 'outcome'])
    res.json(await finance.resolveDispute(req.auth.user.id, req.params.id, req.params.paymentId, req.body.note, req.body.outcome || 'release'))
  })
  router.post('/groups/:id/payouts/:payoutId/review', writes, async (req, res) => {
    fields(req.body, ['action', 'note', 'transferRef', 'bankTransferConfirmed', 'bankTransferNotSent'])
    if (req.body.action === 'complete' && req.body.bankTransferConfirmed !== true) throw new HttpError(400, 'Phải xác nhận đã thực hiện chuyển tiền ngân hàng.')
    res.json(await finance.reviewPayout(req.auth.user.id, req.params.id, req.params.payoutId, req.body))
  })
  return router
}
