export function activityReadiness(activity) {
  const approved = (activity.joinRequests ?? []).filter(member => member.status === 'approved')
  const confirmedParticipants = 1 + approved.length
  const externalParticipants = approved.filter(member => !['host-added', 'host-invited'].includes(member.source)).length
  const minimum = 2
  const unpaid = activity.organizerType === 'business' && activity.depositAmount > 0 && approved.some(member => !activity.businessReceipts?.some(receipt => receipt.userId === member.userId && receipt.status === 'paid'))
  const reason = approved.length < 1
    ? 'Cần ít nhất 1 thành viên tham gia nhóm trước khi chốt lịch và bắt đầu.'
    : unpaid ? 'Còn thành viên chưa được ghi nhận tiền cọc.' : ''
  return { confirmedParticipants, externalParticipants, minimum, ready: !reason, reason }
}
