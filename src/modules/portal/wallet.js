// Manual receipts are evidence awaiting reconciliation, never spendable funds.
export function businessWallet(rows) {
  const groups = rows.map(row => {
    const receipts = new Map((row.businessReceipts ?? []).map(receipt => [receipt.userId, receipt]))
    const members = new Set((row.joinRequests ?? []).filter(member => member.status === 'approved').map(member => member.userId))
    const attendedIds = new Set((row.attendance ?? []).filter(item => ['present', 'late'].includes(item.status)).map(item => item.userId))
    let recordedAmount = 0, recordedMembers = 0, attendedMembers = 0
    for (const userId of members) {
      const receipt = receipts.get(userId)
      if (receipt?.status !== 'paid' || !Number.isSafeInteger(receipt.amount) || receipt.amount <= 0) continue
      recordedAmount += receipt.amount
      recordedMembers++
      if (attendedIds.has(userId)) attendedMembers++
    }
    // Round per participant, in whole VND, rather than rounding a combined fee.
    const estimatedFee = [...members].reduce((sum, id) => {
      const receipt = receipts.get(id)
      return sum + (receipt?.status === 'paid' && Number.isSafeInteger(receipt.amount) && receipt.amount > 0 ? Math.round(receipt.amount / 10) : 0)
    }, 0)
    const estimatedNet = recordedAmount - estimatedFee
    const escrowStatus = ['cancelled', 'expired'].includes(row.status)
      ? 'refund-protected'
      : row.status === 'completed'
        ? 'eligible-after-completion'
        : 'held-in-escrow'
    return { id: row.id, name: row.businessGroupName || row.title, status: row.status, recordedMembers, attendedMembers, recordedAmount, estimatedFee, estimatedNet, escrowStatus }
  })
  const escrowHeldAmount = groups.filter(g => g.escrowStatus === 'held-in-escrow').reduce((sum, g) => sum + g.estimatedNet, 0)
  const eligiblePayoutAmount = groups.filter(g => g.escrowStatus === 'eligible-after-completion').reduce((sum, g) => sum + g.estimatedNet, 0)
  const refundableAmount = groups.filter(g => g.escrowStatus === 'refund-protected').reduce((sum, g) => sum + g.recordedAmount, 0)
  return { currency: 'VND', mode: 'manual-reconciliation', estimatedFeeBps: 1000, availableBalance: 0, verifiedHeldBalance: 0,
    escrowHeldAmount, eligiblePayoutAmount, refundableAmount,
    recordedAmount: groups.reduce((sum, group) => sum + group.recordedAmount, 0),
    estimatedFee: groups.reduce((sum, group) => sum + group.estimatedFee, 0),
    estimatedNet: groups.reduce((sum, group) => sum + group.estimatedNet, 0), groups }
}
