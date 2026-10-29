// Manual receipts are evidence awaiting reconciliation, never spendable funds.
export function businessWallet(rows) {
  const groups = rows.map(row => {
    const receipts = new Map((row.businessReceipts ?? []).map(receipt => [receipt.userId, receipt]))
    const members = new Set((row.joinRequests ?? []).filter(member => member.status === 'approved').map(member => member.userId))
    let recordedAmount = 0, recordedMembers = 0
    for (const userId of members) {
      const receipt = receipts.get(userId)
      if (receipt?.status !== 'paid' || !Number.isSafeInteger(receipt.amount) || receipt.amount <= 0) continue
      recordedAmount += receipt.amount
      recordedMembers++
    }
    // Round per participant, in whole VND, rather than rounding a combined fee.
    const estimatedFee = [...members].reduce((sum, id) => {
      const receipt = receipts.get(id)
      return sum + (receipt?.status === 'paid' && Number.isSafeInteger(receipt.amount) && receipt.amount > 0 ? Math.round(receipt.amount / 10) : 0)
    }, 0)
    return { id: row.id, name: row.businessGroupName || row.title, status: row.status, recordedMembers, recordedAmount, estimatedFee, estimatedNet: recordedAmount - estimatedFee }
  })
  return { currency: 'VND', mode: 'manual-reconciliation', estimatedFeeBps: 1000, availableBalance: 0, verifiedHeldBalance: 0,
    recordedAmount: groups.reduce((sum, group) => sum + group.recordedAmount, 0),
    estimatedFee: groups.reduce((sum, group) => sum + group.estimatedFee, 0),
    estimatedNet: groups.reduce((sum, group) => sum + group.estimatedNet, 0), groups }
}
