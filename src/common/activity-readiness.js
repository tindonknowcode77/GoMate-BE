export function activityReadiness(activity) {
  const approved = (activity.joinRequests ?? []).filter(member => member.status === 'approved')
  const confirmedParticipants = 1 + approved.length
  const externalParticipants = approved.filter(member => !['host-added', 'host-invited'].includes(member.source)).length
  const minimum = activity.minParticipants ?? 2
  const unpaid = activity.organizerType === 'business' && activity.depositAmount > 0 && approved.some(member => !activity.businessReceipts?.some(receipt => receipt.userId === member.userId && receipt.status === 'paid'))
  const reason = confirmedParticipants < minimum
    ? `Cần ít nhất ${minimum} tài khoản xác nhận tham gia (hiện có ${confirmedParticipants}); không tính người đi cùng ngoài GoMate.`
    : externalParticipants < 1 ? 'Cần ít nhất một thành viên bên ngoài được duyệt tham gia; không tính bạn bè do host mời hoặc người đi cùng có sẵn.' : unpaid ? 'Còn thành viên chưa được ghi nhận tiền cọc.' : ''
  return { confirmedParticipants, externalParticipants, minimum, ready: !reason, reason }
}
