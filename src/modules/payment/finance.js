import { createHash, randomUUID } from 'node:crypto'
import { HttpError } from '../../common/http-error.js'
import { createCommunityRepository } from '../community/repository.js'
import { financePolicy } from './policy.js'

const clean = row => { if (!row) return null; const { _id, ...value } = row; return value }
const money = value => { if (!Number.isSafeInteger(value) || value <= 0 || value > 1000000000) throw new HttpError(400, 'Số tiền phải là số nguyên VND lớn hơn 0, tối đa 1 tỷ.'); return value }
const text = (value, label, min = 3, max = 500) => { if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max || /[\x00-\x08\x0b-\x1f]/.test(value)) throw new HttpError(400, `${label}: nhập từ ${min} đến ${max} ký tự.`); return value.trim() }
const entry = (actorId, action, detail = {}) => ({ id: randomUUID(), actorId, action, ...detail, createdAt: new Date() })
export function bankFields(body) {
  const bankId = text(body?.bankId, 'Mã ngân hàng', 2, 20).toUpperCase()
  const accountNo = text(body?.accountNo, 'Số tài khoản', 6, 25).replace(/\s/g, '')
  const accountName = text(body?.accountName, 'Chủ tài khoản', 3, 120).toUpperCase()
  if (!/^[A-Z0-9]{2,20}$/.test(bankId) || !/^\d{6,25}$/.test(accountNo)) throw new HttpError(400, 'Mã ngân hàng hoặc số tài khoản không hợp lệ.')
  return { bankId, accountNo, accountName, branch: typeof body.branch === 'string' ? body.branch.trim().slice(0, 120) : '' }
}

export function createFinanceRepository(db) {
  const escrows = db.collection('finance_escrows'), payments = db.collection('payments'), activities = db.collection('activities')
  const banks = db.collection('user_bank_accounts'), businessBanks = db.collection('business_bank_accounts'), transfers = db.collection('finance_transfers')
  const community = createCommunityRepository(db), policy = financePolicy()
  const notify = (userId, key, title, message) => community.notify(userId, { key, type: 'business-finance', title, text: message }).catch(() => {})
  async function admin(actorId) { if (!await db.collection('users').findOne({ id: actorId, role: 'admin', deletedAt: { $exists: false } })) throw new HttpError(403, 'Chỉ admin được xử lý tài chính.') }
  async function business(ownerId) { if (!await db.collection('business_applications').findOne({ ownerId, status: 'approved' })) throw new HttpError(403, 'Doanh nghiệp chưa được xác minh.') }
  async function mutate(id, action) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await escrows.findOne({ _id: id })
      if (!current) throw new HttpError(404, 'Chưa có tiền cọc đã được đối soát cho hoạt động này.')
      if ((current.audit?.length || 0) >= 5000) throw new HttpError(409, 'Hồ sơ đạt giới hạn thao tác; cần admin đối soát riêng.')
      const draft = structuredClone(current), activity = await activities.findOne({ id: current.activityId })
      const result = await action(draft, activity)
      const saved = await escrows.replaceOne({ _id: id, version: current.version }, { ...draft, version: current.version + 1, updatedAt: new Date() })
      if (saved.matchedCount) return result
    }
    throw new HttpError(409, 'Dữ liệu tài chính vừa thay đổi. Vui lòng thử lại.')
  }
  const keyFor = payment => payment.activityId || `wallet:${payment.userId}`
  function releaseAt(escrow, activity) {
    const end = Math.max(+new Date(activity?.endsAt || 0), +new Date(activity?.completedAt || activity?.autoCompletedAt || 0), ...escrow.lots.map(lot => +new Date(lot.endsAt || 0)))
    return new Date(end + Math.max(policy.settlementHoldHours, ...escrow.lots.map(lot => lot.holdHours || 48)) * 3600000)
  }
  function blockers(escrow, activity) {
    if (!activity || activity.status !== 'completed' || activity.businessRevoked) return 'Hoạt động chưa hoàn tất hợp lệ.'
    if (releaseAt(escrow, activity) > new Date()) return 'Chưa hết thời gian giữ cọc sau lịch kết thúc.'
    if (escrow.lots.some(lot => ['refund_requested', 'refund_approved', 'disputed'].includes(lot.state))) return 'Còn yêu cầu hoàn tiền hoặc khiếu nại chưa xử lý.'
    return ''
  }
  const fee = amount => Math.round(amount / 10)
  async function synchronizePayment(payment) {
    if (!payment.verification || !Number.isSafeInteger(payment.receivedAmount) || payment.receivedAmount <= 0) return
    const activity = payment.activityId ? await activities.findOne({ id: payment.activityId }) : null
    const id = keyFor(payment)
    try { await escrows.updateOne({ _id: id }, { $setOnInsert: { activityId: payment.activityId || null, ownerId: activity?.hostId || null, title: activity?.title || payment.activityTitle || 'Tiền chờ hoàn', lots: [], payouts: [], settlement: { status: 'waiting' }, audit: [], version: 0, createdAt: new Date() } }, { upsert: true }) } catch (error) { if (error.code !== 11000) throw error }
    await mutate(id, draft => {
      if (!draft.lots.some(lot => lot.paymentId === payment.id)) {
        if (draft.lots.length >= 2000) throw new HttpError(409, 'Quá nhiều giao dịch trong hoạt động; cần admin xử lý riêng.')
        draft.lots.push({ paymentId: payment.id, userId: payment.userId, amount: payment.receivedAmount, state: 'held', refundOnly: Boolean(payment.refundOnly), startsAt: payment.activityStartsAt || activity?.startsAt, endsAt: payment.activityEndsAt || activity?.endsAt, cancelBefore: payment.cancellationDeadline, holdHours: payment.policy?.settlementHoldHours || policy.settlementHoldHours, verifiedAt: payment.paidAt, confirmation: null, refund: null })
        // Incoming money after a settlement review requires a fresh review.
        if (draft.settlement.status === 'approved') draft.settlement = { status: 'waiting' }
        draft.audit.push(entry(payment.verification.actorId, 'incoming-verified', { paymentId: payment.id, amount: payment.receivedAmount }))
      }
    })
    await payments.updateOne({ id: payment.id }, { $set: { financeSynced: true } })
    if (activity && !payment.refundOnly) {
      const receipt = { userId: payment.userId, paymentId: payment.id, orderCode: payment.orderCode, amount: payment.receivedAmount, status: 'paid', method: payment.verification.source, recordedBy: payment.verification.actorId, paidAt: payment.paidAt, recordedAt: new Date(), verified: true }
      await activities.updateOne({ id: activity.id, businessReceipts: { $not: { $elemMatch: { paymentId: payment.id } } } }, [{ $set: { businessReceipts: { $concatArrays: [{ $filter: { input: { $ifNull: ['$businessReceipts', []] }, as: 'receipt', cond: { $ne: ['$$receipt.userId', payment.userId] } } }, [receipt]] }, version: { $add: [{ $ifNull: ['$version', 0] }, 1] }, updatedAt: new Date() } }])
    }
  }
  async function refundContext(payment, userId) {
    if (!payment || payment.userId !== userId) throw new HttpError(404, 'Không tìm thấy giao dịch của bạn.')
    const escrow = await escrows.findOne({ _id: keyFor(payment) }), lot = escrow?.lots.find(lot => lot.paymentId === payment.id)
    return { escrow, lot }
  }
  async function outgoing(reference, requestId, amount, actorId) {
    const transferRef = text(reference, 'Mã giao dịch ngân hàng', 6, 120)
    if (!/^[\w./:-]{6,120}$/.test(transferRef)) throw new HttpError(400, 'Mã giao dịch ngân hàng không hợp lệ.')
    const id = createHash('sha256').update(transferRef.toUpperCase()).digest('hex')
    if (await db.collection('bank_events').findOne({ _id: id })) throw new HttpError(409, 'Mã này là tiền vào, không được dùng làm chứng từ chuyển tiền ra.')
    try { await transfers.insertOne({ _id: id, transferRef, requestId, amount, actorId, createdAt: new Date() }) }
    catch (error) { if (error.code !== 11000) throw error; const previous = await transfers.findOne({ _id: id }); if (previous.requestId !== requestId || previous.amount !== amount) throw new HttpError(409, 'Mã giao dịch ngân hàng đã dùng cho lệnh khác.') }
    return transferRef
  }
  async function mirrorRefunds(escrow) {
    for (const lot of escrow.lots.filter(lot => lot.state === 'refunded')) {
      await payments.updateOne({ id: lot.paymentId }, { $set: { status: 'refunded', refundedAt: lot.refund.completedAt, refundInfo: { ...lot.refund.bankAccount, refundCode: lot.refund.id, transactionRef: lot.refund.transferRef, reason: lot.refund.reason } }, $unset: { activeKey: '' } })
      if (escrow.activityId) await activities.updateOne({ id: escrow.activityId, businessReceipts: { $elemMatch: { paymentId: lot.paymentId, status: { $ne: 'refunded' } } } }, { $set: { 'businessReceipts.$.status': 'refunded', 'businessReceipts.$.refundedAt': lot.refund.completedAt }, $inc: { version: 1 } })
    }
    await escrows.updateOne({ _id: escrow._id, version: escrow.version }, { $unset: { refundMirrorPending: '' } })
  }
  async function enrich(payment) {
    const { escrow, lot } = await refundContext(payment, payment.userId)
    const activity = payment.activityId ? await activities.findOne({ id: payment.activityId }, { projection: { status: 1, title: 1, startsAt: 1, businessRevoked: 1 } }) : null
    const early = Boolean(lot?.cancelBefore && new Date(lot.cancelBefore) > new Date())
    const fullRefund = lot?.refundOnly || !activity || activity.businessRevoked || ['cancelled', 'expired', 'deleted'].includes(activity?.status) || early
    return { ...clean(payment), activityStatus: activity?.status || null, financeState: lot?.state || (payment.status === 'paid' ? 'unreconciled' : null), refundEligible: Boolean(lot && ['held', 'disputed', 'payout_reserved'].includes(lot.state)), refundPolicy: fullRefund ? 'full_refund' : 'manual_review', refundAmount: lot?.amount || 0, refundRequest: lot?.refund || null, participantConfirmation: lot?.confirmation || null, canConfirmAttendance: Boolean(lot && ['held', 'payout_reserved'].includes(lot.state) && !lot.refundOnly && activity && new Date(lot.startsAt || activity.startsAt) <= new Date()), payout: escrow?.payouts.find(payout => payout.lotIds.includes(payment.id)) || null }
  }
  return {
    policy, synchronizePayment, enrich,
    async reconcile() {
      for (const payment of await payments.find({ verification: { $exists: true }, financeSynced: { $ne: true } }).limit(100).toArray()) await synchronizePayment(payment)
      for (const escrow of await escrows.find({ refundMirrorPending: true }).limit(100).toArray()) await mirrorRefunds(escrow)
    },
    async saveUserBank(userId, body) { const bank = bankFields(body); await banks.updateOne({ _id: userId }, { $set: { ...bank, updatedAt: new Date() } }, { upsert: true }); return bank },
    async userWallet(userId, page = 1, limit = 20) {
      const rows = await payments.find({ userId }).sort({ createdAt: -1, id: 1 }).skip((page - 1) * limit).limit(limit).toArray()
      const ledgers = await escrows.find({ 'lots.userId': userId }).toArray(), lots = ledgers.flatMap(ledger => ledger.lots.filter(lot => lot.userId === userId))
      return { items: await Promise.all(rows.map(enrich)), total: await payments.countDocuments({ userId }), page, hasMore: page * limit < await payments.countDocuments({ userId }), bankAccount: clean(await banks.findOne({ _id: userId })), policy,
        summary: { totalPaid: lots.filter(lot => !['refunded', 'settled'].includes(lot.state)).reduce((sum, lot) => sum + lot.amount, 0), refundableAmount: lots.filter(lot => ['held', 'disputed'].includes(lot.state)).reduce((sum, lot) => sum + lot.amount, 0), refundedAmount: lots.filter(lot => lot.state === 'refunded').reduce((sum, lot) => sum + lot.amount, 0), pendingRefundAmount: lots.filter(lot => ['refund_requested', 'refund_approved'].includes(lot.state)).reduce((sum, lot) => sum + lot.amount, 0) } }
    },
    async requestRefund(paymentId, userId, body) {
      const payment = await payments.findOne({ id: paymentId, userId })
      const { lot } = await refundContext(payment, userId)
      if (!lot) throw new HttpError(409, 'Giao dịch cần được đối soát tiền vào trước khi hoàn.')
      const reason = text(body?.reason, 'Lý do hoàn tiền', 5, 500)
      const bankAccount = body?.accountNo ? bankFields(body) : clean(await banks.findOne({ _id: userId }))
      if (!bankAccount) throw new HttpError(400, 'Hãy lưu tài khoản nhận hoàn tiền trong ví trước.')
      const result = await mutate(keyFor(payment), (draft, activity) => {
        const current = draft.lots.find(lot => lot.paymentId === paymentId)
        if (['refund_requested', 'refund_approved', 'refunded'].includes(current.state)) return current.refund
        if (!['held', 'disputed', 'payout_reserved'].includes(current.state)) throw new HttpError(409, 'Khoản cọc đã giải ngân; hãy gửi yêu cầu hỗ trợ để đối soát.')
        if (draft.payouts.some(payout => payout.status === 'processing' && payout.lotIds.includes(paymentId))) throw new HttpError(409, 'Ngân hàng đang xử lý giải ngân. Cần admin đối soát kết quả trước khi xử lý hoàn tiền; không gửi lệnh chuyển khác.')
        for (const payout of draft.payouts.filter(payout => ['pending', 'approved'].includes(payout.status) && payout.lotIds.includes(paymentId))) {
          payout.status = 'blocked'; payout.reviewNote = 'Phát sinh yêu cầu hoàn tiền.'
          for (const item of draft.lots.filter(item => item.payoutId === payout.id && item.state === 'payout_reserved')) { item.state = 'held'; delete item.payoutId }
        }
        const full = current.refundOnly || !activity || activity.businessRevoked || ['cancelled', 'expired', 'deleted'].includes(activity?.status) || current.cancelBefore && new Date(current.cancelBefore) > new Date()
        current.refund = { id: randomUUID(), status: 'pending', amount: current.amount, reason, bankAccount, policy: full ? 'full_refund' : 'manual_review', requestedAt: new Date() }
        current.state = 'refund_requested'; draft.settlement = { status: 'waiting' }
        draft.audit.push(entry(userId, 'refund-requested', { paymentId, amount: current.amount }))
        return current.refund
      })
      // A refund request also gives up the seat before the event starts.
      if (payment.activityId) await activities.updateOne({ id: payment.activityId, status: 'published', startsAt: { $gt: new Date() }, memberCount: { $gt: 0 }, joinRequests: { $elemMatch: { userId, status: 'approved' } } }, { $set: { 'joinRequests.$.status': 'left', 'joinRequests.$.updatedAt': new Date(), scheduleConfirmedAt: null }, $inc: { memberCount: -1, version: 1 } })
      await notify(userId, `refund:${result.id}`, 'Đã tiếp nhận yêu cầu hoàn cọc', 'Đang chờ admin duyệt; chưa chuyển tiền.')
      return enrich(await payments.findOne({ id: paymentId }))
    },
    async confirmParticipation(paymentId, userId, status, note = '') {
      if (!['attended', 'disputed'].includes(status)) throw new HttpError(400, 'Chọn đã tham gia hoặc khiếu nại.')
      const payment = await payments.findOne({ id: paymentId, userId }); await refundContext(payment, userId)
      return mutate(keyFor(payment), (draft, activity) => {
        const lot = draft.lots.find(lot => lot.paymentId === paymentId)
        if (!lot || lot.refundOnly || !['held', 'disputed', 'payout_reserved'].includes(lot.state)) throw new HttpError(409, 'Khoản cọc không còn ở trạng thái xác nhận.')
        if (!activity || new Date(lot.startsAt || activity.startsAt) > new Date()) throw new HttpError(409, 'Chưa đến thời gian diễn ra hoạt động.')
        if (draft.payouts.some(payout => payout.status === 'processing' && payout.lotIds.includes(paymentId))) throw new HttpError(409, 'Lệnh ngân hàng đang xử lý. Liên hệ hỗ trợ để đối soát; không tự động trả lại số dư.')
        if (status === 'disputed') {
          text(note, 'Nội dung khiếu nại', 5, 500)
          for (const payout of draft.payouts.filter(item => ['pending', 'approved'].includes(item.status) && item.lotIds.includes(paymentId))) {
            payout.status = 'blocked'; payout.reviewNote = 'Thành viên gửi khiếu nại.'
            for (const item of draft.lots.filter(item => item.payoutId === payout.id)) { item.state = 'held'; delete item.payoutId }
          }
          lot.state = 'disputed'; draft.settlement = { status: 'waiting' }
        } else if (lot.state === 'disputed') throw new HttpError(409, 'Khiếu nại đang chờ admin xử lý.')
        lot.confirmation = { status, note: String(note).slice(0, 500), userId, createdAt: new Date() }
        draft.audit.push(entry(userId, 'participant-confirmation', { paymentId, status }))
        return lot.confirmation
      })
    },
    async businessWallet(ownerId) {
      await business(ownerId)
      const rows = await escrows.find({ ownerId }).toArray(), groups = [], payouts = []
      let recordedAmount = 0, held = 0, eligible = 0, paidOutAmount = 0, feeRevenue = 0
      for (const row of rows) {
        const activity = await activities.findOne({ id: row.activityId }), blocked = blockers(row, activity)
        const available = row.lots.filter(lot => lot.state === 'held' && !lot.refundOnly)
        const gross = available.reduce((sum, lot) => sum + lot.amount, 0), net = available.reduce((sum, lot) => sum + lot.amount - fee(lot.amount), 0)
        const ready = !blocked && row.settlement.status === 'approved'
        eligible += ready ? net : 0
        recordedAmount += row.lots.reduce((sum, lot) => sum + lot.amount, 0)
        held += row.lots.filter(lot => !['refunded', 'settled'].includes(lot.state)).reduce((sum, lot) => sum + lot.amount, 0)
        paidOutAmount += row.payouts.filter(item => item.status === 'completed').reduce((sum, item) => sum + item.amount, 0)
        feeRevenue += row.payouts.filter(item => item.status === 'completed').reduce((sum, item) => sum + item.feeAmount, 0)
        const heldAmount = row.lots.filter(lot => !['refunded', 'settled'].includes(lot.state)).reduce((sum, lot) => sum + lot.amount, 0)
        const escrowStatus = row.payouts.some(item => item.status === 'processing') ? 'processing' : row.payouts.some(item => ['pending', 'approved'].includes(item.status)) ? 'requested' : heldAmount === 0 ? (row.lots.some(lot => lot.state === 'settled') ? 'settled' : 'refunded') : ready && net > 0 ? 'admin-approved' : 'awaiting-review'
        groups.push({ id: row.activityId, name: activity?.businessGroupName || activity?.title || row.title, status: activity?.status, recordedAmount: gross, heldAmount, recordedMembers: row.lots.length, estimatedFee: gross - net, estimatedNet: net, eligibleAmount: ready ? net : 0, escrowStatus, holdUntil: releaseAt(row, activity), settlement: row.settlement, blockedReason: blocked || (row.settlement.status !== 'approved' ? 'Chờ admin xác minh hoạt động.' : '') })
        payouts.push(...row.payouts.map(payout => ({ ...payout, activityId: row.activityId, activityTitle: row.title })))
      }
      const legacyPayouts = await db.collection('business_payouts').find({ ownerId }).limit(50).toArray()
      return { currency: 'VND', mode: 'verified-escrow', bankAccount: clean(await businessBanks.findOne({ ownerId })), groups, payouts: payouts.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)), legacyPayouts: legacyPayouts.map(clean), recordedAmount, escrowHeldAmount: held, eligiblePayoutAmount: eligible, withdrawableAmount: eligible, paidOutAmount, estimatedFee: feeRevenue, estimatedNet: recordedAmount - feeRevenue, refundableAmount: rows.flatMap(row => row.lots).filter(lot => ['refund_requested', 'refund_approved'].includes(lot.state)).reduce((sum, lot) => sum + lot.amount, 0), availableBalance: eligible, policy }
    },
    async requestPayout(ownerId, body) {
      await business(ownerId)
      const activityId = text(body?.activityId, 'Hoạt động', 1, 100), requestKey = text(body?.clientRequestId, 'Mã yêu cầu', 8, 100)
      const bankAccount = clean(await businessBanks.findOne({ ownerId }))
      if (!bankAccount) throw new HttpError(400, 'Hãy lưu tài khoản nhận giải ngân trước.')
      const requestedAmount = money(body.amount)
      const payout = await mutate(activityId, (draft, activity) => {
        if (draft.ownerId !== ownerId) throw new HttpError(403, 'Không có quyền giải ngân hoạt động này.')
        const previous = draft.payouts.find(payout => payout.clientRequestId === requestKey)
        if (previous) { if (previous.amount !== requestedAmount) throw new HttpError(409, 'Mã yêu cầu đã được dùng với số tiền khác.'); return previous }
        const blocked = blockers(draft, activity)
        if (blocked || draft.settlement.status !== 'approved') throw new HttpError(409, blocked || 'Admin chưa xác minh hoạt động để giải ngân.')
        const lots = draft.lots.filter(lot => lot.state === 'held' && !lot.refundOnly)
        const gross = lots.reduce((sum, lot) => sum + lot.amount, 0), feeAmount = lots.reduce((sum, lot) => sum + fee(lot.amount), 0)
        if (!lots.length || requestedAmount !== gross - feeAmount) throw new HttpError(409, 'Yêu cầu phải bằng toàn bộ số dư khả dụng của hoạt động đã chọn. Hãy làm mới ví.')
        const value = { id: randomUUID(), clientRequestId: requestKey, referenceCode: 'PO' + randomUUID().slice(0, 8).toUpperCase(), ownerId, lotIds: lots.map(lot => lot.paymentId), amount: requestedAmount, grossAmount: gross, feeAmount, bankAccount, status: 'pending', note: String(body.note || '').slice(0, 500), createdAt: new Date() }
        for (const lot of lots) { lot.state = 'payout_reserved'; lot.payoutId = value.id }
        draft.payouts.push(value); draft.audit.push(entry(ownerId, 'payout-requested', { payoutId: value.id, amount: requestedAmount }))
        return value
      })
      return { payout, wallet: await this.businessWallet(ownerId) }
    },
    async reviewSettlement(actorId, activityId, body) {
      await admin(actorId)
      const evidence = text(body?.evidence, 'Bằng chứng xác minh hoạt động', 10, 2000)
      const note = text(body?.note, 'Kết quả đối soát', 5, 1000)
      return mutate(activityId, (draft, activity) => {
        if (draft.ownerId === actorId) throw new HttpError(403, 'Không tự duyệt hoạt động của mình.')
        const blocked = blockers(draft, activity); if (blocked) throw new HttpError(409, blocked)
        if (draft.payouts.some(payout => ['pending', 'approved', 'processing'].includes(payout.status))) throw new HttpError(409, 'Hoạt động có lệnh giải ngân đang xử lý.')
        const lots = draft.lots.filter(lot => lot.state === 'held' && !lot.refundOnly)
        if (!lots.length) throw new HttpError(409, 'Không có cọc đã đối soát đủ điều kiện.')
        const missing = lots.filter(lot => lot.confirmation?.status !== 'attended')
        const overrideReason = missing.length ? text(body.overrideReason, 'Lý do xác minh thay xác nhận của thành viên', 15, 1000) : ''
        draft.settlement = { status: 'approved', reviewedBy: actorId, reviewedAt: new Date(), evidence, note, overrideReason, missingConfirmations: missing.map(lot => lot.paymentId) }
        draft.audit.push(entry(actorId, 'settlement-approved', { evidence, note, overrideReason }))
        return draft.settlement
      })
    },
    async reviewRefund(actorId, paymentId, body) {
      await admin(actorId)
      const payment = await payments.findOne({ id: paymentId }); if (!payment) throw new HttpError(404, 'Không tìm thấy giao dịch.')
      const note = text(body?.note, 'Ghi chú xử lý', 5, 1000), action = body.action
      if (!['approve', 'reject', 'complete'].includes(action)) throw new HttpError(400, 'Thao tác không hợp lệ.')
      const row = await escrows.findOne({ _id: keyFor(payment) }), lot = row?.lots.find(item => item.paymentId === paymentId)
      if (!lot?.refund) throw new HttpError(404, 'Không có yêu cầu hoàn tiền.')
      if (actorId === lot.userId || actorId === row.ownerId) throw new HttpError(403, 'Không tự xử lý hoàn tiền liên quan đến mình.')
      if (action === 'complete' && !['refund_approved', 'refunded'].includes(lot.state)) throw new HttpError(409, 'Phải duyệt hoàn tiền trước khi ghi nhận chuyển tiền.')
      const transferRef = action === 'complete' ? await outgoing(body.transferRef, lot.refund.id, lot.amount, actorId) : null
      const result = await mutate(keyFor(payment), draft => {
        const current = draft.lots.find(item => item.paymentId === paymentId), request = current.refund
        if (actorId === current.userId) throw new HttpError(403, 'Không tự duyệt hoàn tiền cho mình.')
        if (action === 'complete' && current.state === 'refunded') { if (request.transferRef !== transferRef) throw new HttpError(409, 'Lệnh đã hoàn tất với mã chuyển tiền khác.'); return request }
        if (action === 'approve') {
          if (current.state !== 'refund_requested') throw new HttpError(409, 'Yêu cầu không còn chờ duyệt.')
          current.state = 'refund_approved'; request.status = 'approved'; request.approvedBy = actorId; request.approvedAt = new Date()
        } else if (action === 'reject') {
          if (current.state !== 'refund_requested' || request.policy === 'full_refund') throw new HttpError(409, 'Không được từ chối quyền hoàn đủ theo chính sách; cần đối soát và hoàn tiền.')
          current.state = 'held'; request.status = 'rejected'
          if (current.confirmation?.status === 'disputed') current.confirmation = { ...current.confirmation, resolvedBy: actorId, resolution: note }
        } else {
          if (current.state !== 'refund_approved') throw new HttpError(409, 'Phải duyệt yêu cầu trước khi xác nhận đã chuyển tiền.')
          current.state = 'refunded'; request.status = 'completed'; request.transferRef = transferRef; request.completedBy = actorId; request.completedAt = new Date()
          draft.refundMirrorPending = true
        }
        request.reviewNote = note; draft.audit.push(entry(actorId, `refund-${action}`, { paymentId, note, transferRef }))
        return request
      })
      await mirrorRefunds(await escrows.findOne({ _id: keyFor(payment) }))
      await notify(payment.userId, `refund:${result.id}:${result.status}`, result.status === 'completed' ? 'Đã ghi nhận chuyển tiền hoàn cọc' : 'Yêu cầu hoàn cọc đã được cập nhật', note)
      return result
    },
    async resolveDispute(actorId, activityId, paymentId, note) {
      await admin(actorId); text(note, 'Kết quả xử lý khiếu nại', 15, 1000)
      return mutate(activityId, draft => {
        const lot = draft.lots.find(lot => lot.paymentId === paymentId)
        if (!lot || lot.state !== 'disputed' || actorId === lot.userId || actorId === draft.ownerId) throw new HttpError(409, 'Không thể đóng khiếu nại này.')
        lot.state = 'held'; lot.confirmation.resolvedBy = actorId; lot.confirmation.resolution = note
        draft.audit.push(entry(actorId, 'dispute-resolved', { paymentId, note })); return lot.confirmation
      })
    },
    async reviewPayout(actorId, activityId, payoutId, body) {
      await admin(actorId)
      const note = text(body?.note, 'Ghi chú xử lý', 5, 1000), action = body.action
      if (!['approve', 'reject', 'start_transfer', 'transfer_failed', 'complete'].includes(action)) throw new HttpError(400, 'Thao tác không hợp lệ.')
      const row = await escrows.findOne({ _id: activityId }), target = row?.payouts.find(item => item.id === payoutId)
      if (!target) throw new HttpError(404, 'Không có yêu cầu giải ngân.')
      if (actorId === row.ownerId) throw new HttpError(403, 'Không tự duyệt giải ngân cho mình.')
      if (action === 'complete' && !['processing', 'completed'].includes(target.status)) throw new HttpError(409, 'Phải duyệt và khóa lệnh chuyển tiền trước khi ghi nhận kết quả.')
      const transferRef = action === 'complete' ? await outgoing(body.transferRef, payoutId, target.amount, actorId) : null
      return mutate(activityId, (draft, activity) => {
        const payout = draft.payouts.find(item => item.id === payoutId)
        if (actorId === draft.ownerId) throw new HttpError(403, 'Không tự duyệt giải ngân cho mình.')
        if (action === 'complete' && payout.status === 'completed') { if (payout.transferRef !== transferRef) throw new HttpError(409, 'Lệnh đã chuyển với mã khác.'); return payout }
        if (action === 'start_transfer' && payout.status === 'processing') return payout
        if (action === 'transfer_failed') {
          if (payout.status !== 'processing' || body.bankTransferNotSent !== true) throw new HttpError(409, 'Chỉ mở khóa khi đã xác nhận ngân hàng không trừ/chuyển tiền.')
          text(note, 'Bằng chứng ngân hàng không thực hiện chuyển tiền', 15, 1000)
          payout.status = 'rejected'; payout.reviewNote = note; draft.settlement = { status: 'waiting' }
          for (const lot of draft.lots.filter(lot => lot.payoutId === payoutId)) { lot.state = 'held'; delete lot.payoutId }
          draft.audit.push(entry(actorId, 'payout-transfer-failed', { payoutId, note })); return payout
        }
        const blocked = blockers(draft, activity)
        if (!['reject', 'complete'].includes(action) && (blocked || draft.settlement.status !== 'approved')) throw new HttpError(409, blocked || 'Cần đối soát lại hoạt động.')
        if (!['pending', 'approved', 'processing'].includes(payout.status)) throw new HttpError(409, 'Yêu cầu không còn khả dụng.')
        const lots = draft.lots.filter(lot => payout.lotIds.includes(lot.paymentId))
        if (lots.length !== payout.lotIds.length || lots.some(lot => lot.state !== 'payout_reserved' || lot.payoutId !== payoutId)) throw new HttpError(409, 'Số dư đang có tranh chấp hoặc đã xử lý.')
        if (action === 'approve') { if (payout.status !== 'pending') throw new HttpError(409, 'Lệnh đã được duyệt.'); payout.status = 'approved'; payout.approvedBy = actorId; payout.approvedAt = new Date() }
        else if (action === 'start_transfer') { if (payout.status !== 'approved') throw new HttpError(409, 'Phải duyệt trước khi khóa lệnh.'); payout.status = 'processing'; payout.transferStartedBy = actorId; payout.transferStartedAt = new Date() }
        else if (action === 'reject') { if (payout.status === 'processing') throw new HttpError(409, 'Lệnh đang chuyển tiền; cần xác minh kết quả ngân hàng.'); payout.status = 'rejected'; for (const lot of lots) { lot.state = 'held'; delete lot.payoutId } }
        else { if (payout.status !== 'processing') throw new HttpError(409, 'Admin phải khóa lệnh trước khi thực hiện chuyển tiền.'); payout.status = 'completed'; payout.transferRef = transferRef; payout.processedAt = new Date(); payout.processedBy = actorId; for (const lot of lots) lot.state = 'settled' }
        payout.reviewNote = note; draft.audit.push(entry(actorId, `payout-${action}`, { payoutId, note, transferRef })); return payout
      })
    },
    async dashboard(actorId, page = 1) {
      await admin(actorId)
      const rows = await escrows.find({}).sort({ updatedAt: -1 }).skip((page - 1) * 20).limit(20).toArray()
      const groups = []
      for (const row of rows) { const activity = await activities.findOne({ id: row.activityId }); groups.push({ ...clean(row), audit: row.audit.slice(-100), id: row._id, activityStatus: activity?.status, holdUntil: releaseAt(row, activity), blockedReason: blockers(row, activity) }) }
      const summary = { received: 0, held: 0, refunded: 0, businessPaid: 0, feeRevenue: 0, pendingRefunds: 0, pendingPayouts: 0 }
      const cursor = escrows.find({}, { projection: { lots: 1, payouts: 1 } })
      for await (const row of cursor) {
        for (const lot of row.lots) { summary.received += lot.amount; if (lot.state === 'refunded') summary.refunded += lot.amount; else if (lot.state !== 'settled') summary.held += lot.amount; if (['refund_requested', 'refund_approved'].includes(lot.state)) summary.pendingRefunds++ }
        for (const payout of row.payouts) { if (payout.status === 'completed') { summary.businessPaid += payout.amount; summary.feeRevenue += payout.feeAmount } else if (['pending', 'approved', 'processing'].includes(payout.status)) summary.pendingPayouts++ }
      }
      const incomingQuery = { $or: [{ status: 'pending', reportedAt: { $exists: true } }, { status: 'paid', verification: { $exists: false } }] }
      const unreconciled = await payments.find(incomingQuery, { projection: { _id: 0 } }).sort({ createdAt: -1, id: 1 }).skip((page - 1) * 50).limit(50).toArray()
      const unmatched = await db.collection('bank_events').find({ paymentId: null }).sort({ createdAt: -1, id: 1 }).skip((page - 1) * 50).limit(50).toArray()
      const legacyPayouts = await db.collection('business_payouts').find({}).sort({ createdAt: -1 }).limit(30).toArray()
      return { summary, groups, total: await escrows.countDocuments(), page, incomingTotal: await payments.countDocuments(incomingQuery), unmatchedTotal: await db.collection('bank_events').countDocuments({ paymentId: null }), unreconciled, unmatched: unmatched.map(clean), legacyPayouts: legacyPayouts.map(clean), policy }
    },
  }
}
