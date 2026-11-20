import { createHash, randomUUID } from 'node:crypto'
import { HttpError } from '../../common/http-error.js'

const ownAttendance = (row, id) => row.attendance?.find(item => item.userId === id) || { userId: id, status: 'unmarked' }
const snapshot = item => ({ status: item.status, updatedAt: item.updatedAt ? new Date(item.updatedAt).toISOString() : null, updatedBy: item.updatedBy || null })
const member = (row, id) => row.hostId === id || row.joinRequests?.some(item => item.userId === id && item.status === 'approved') || row.attendance?.some(item => item.userId === id)
export async function attendanceSummary(db, userId) {
  return (await attendanceSummaries(db, [userId])).get(userId)
}
export async function attendanceSummaries(db, userIds) {
  if (!userIds.length) return new Map()
  const rows = await db.collection('activities').aggregate([
    { $match: { status: 'completed', 'attendance.userId': { $in: userIds } } }, { $unwind: '$attendance' },
    { $match: { 'attendance.userId': { $in: userIds }, 'attendance.status': { $in: ['present', 'late', 'absent'] } } },
    { $group: { _id: { activity: '$id', user: '$attendance.userId' }, status: { $first: '$attendance.status' } } },
    { $group: { _id: { user: '$_id.user', status: '$status' }, count: { $sum: 1 } } },
  ]).toArray()
  return new Map(userIds.map(userId => {
  const count = status => rows.find(row => row._id.user === userId && row._id.status === status)?.count || 0
  const presentCount = count('present'), lateCount = count('late'), absentCount = count('absent'), attendanceCount = presentCount + lateCount + absentCount
  return [userId, { attendanceCount, presentCount, lateCount, absentCount, absenceRate: attendanceCount ? Math.round(absentCount / attendanceCount * 1000) / 10 : null }]
  }))
}

export async function notifyUnmarkedStart(community, row, actorId) {
  const ids = [...new Set((row.joinRequests || []).filter(item => item.status === 'approved').map(item => item.userId))]
  await Promise.all(ids.filter(id => ownAttendance(row, id).status === 'unmarked').map(userId => community.notifyScheduled(userId, {
    key: `attendance-start:${row.id}:${userId}:${new Date(row.startedAt).toISOString()}`, type: 'attendance', title: 'Bạn chưa được điểm danh',
    text: `${row.title} đã bắt đầu nhưng bạn chưa được điểm danh. Trạng thái này chưa tính là vắng mặt. Mở thông báo để xem và gửi khiếu nại nếu cần.`, activityId: row.id, actorId,
  })))
}

export function createAttendanceRepository(db, community) {
  const activities = db.collection('activities'), reports = db.collection('reports')
  const view = row => ({ id: row.id, activityId: row.activityId, type: row.type, kind: row.kind, activityTitle: row.activityTitle, reason: row.reason, detail: row.detail, status: row.status, requestedStatus: row.requestedStatus, reviewNote: row.reviewNote, correctedStatus: row.correctedStatus, createdAt: row.createdAt, resolvedAt: row.resolvedAt })
  const notifyResult = report => community.notify(report.reporterId, { key: `attendance-complaint:${report.id}:resolved`, type: 'attendance', title: 'Khiếu nại đã được xử lý', text: report.reviewNote, activityId: report.activityId })
  return {
    async history(userId, page = 1, limit = 20) {
      const query = { status: { $in: ['published', 'in-progress', 'completed'] }, $or: [{ hostId: userId }, { joinRequests: { $elemMatch: { userId, status: 'approved' } } }, { 'attendance.userId': userId }] }
      const rows = await activities.find(query).sort({ startedAt: -1, endsAt: -1, id: 1 }).skip((page - 1) * limit).limit(limit).toArray(), total = await activities.countDocuments(query)
      return { items: rows.map(row => ({ id: row.id, title: row.title, activityStatus: row.status, status: ownAttendance(row, userId).status, updatedAt: ownAttendance(row, userId).updatedAt || null })), page, limit, total, hasMore: page * limit < total }
    },
    async submit(userId, body) {
      const row = await activities.findOne({ id: body.activityId, status: { $ne: 'deleted' } })
      if (!row || !member(row, userId)) throw new HttpError(403, 'Chỉ người tham gia được khiếu nại hoạt động này.')
      const current = ownAttendance(row, userId)
      if (body.kind === 'attendance' && !(current.status === 'absent' || current.status === 'unmarked' && ['in-progress', 'completed'].includes(row.status))) throw new HttpError(409, 'Chỉ khiếu nại điểm danh vắng hoặc chưa được điểm danh trong hoạt động đã bắt đầu.')
      const observed = snapshot(current), key = `member-complaint:${userId}:${row.id}:${body.kind}:${createHash('sha256').update(JSON.stringify(observed)).digest('hex')}`
      let result
      try { result = await reports.findOneAndUpdate({ key }, { $setOnInsert: { id: randomUUID(), key, type: 'member-complaint', ...body, reporterId: userId, activityTitle: row.title, attendanceSnapshot: observed, status: 'pending', reason: body.kind === 'attendance' ? 'Khiếu nại điểm danh' : 'Khiếu nại vấn đề khác', createdAt: new Date(), adminVersion: 0 } }, { upsert: true, returnDocument: 'after' }) }
      catch (error) { if (error.code !== 11000) throw error; result = await reports.findOne({ key }) }
      return view(result)
    },
    async resolve(actorId, id, body) {
      if (!await db.collection('users').findOne({ id: actorId, role: 'admin', deletedAt: { $exists: false } })) throw new HttpError(403, 'Chỉ Admin được xử lý khiếu nại.')
      let report = await reports.findOne({ id, type: 'member-complaint' })
      if (!report) throw new HttpError(404, 'Không tìm thấy khiếu nại.')
      if (report.reporterId === actorId) throw new HttpError(403, 'Không tự xử lý khiếu nại của mình.')
      const resolution = { actorId, decision: body.decision, status: body.status || null, note: body.note }
      const same = value => JSON.stringify(value) === JSON.stringify(resolution)
      if (report.status !== 'pending') { if (same(report.resolution)) { await notifyResult(report); return view(report) } throw new HttpError(409, 'Khiếu nại đã được xử lý.') }
      if (report.kind !== 'attendance' && body.status) throw new HttpError(400, 'Khiếu nại khác không được sửa điểm danh.')
      if (body.decision === 'approve' && report.kind === 'attendance' && !['present', 'late', 'absent', 'unmarked'].includes(body.status)) throw new HttpError(400, 'Chọn kết quả điểm danh đã xác minh.')
      if (report.resolution && !same(report.resolution)) throw new HttpError(409, 'Khiếu nại đang được xử lý bởi quyết định khác.')
      if (!report.resolution) {
        report = await reports.findOneAndUpdate({ id, status: 'pending', resolution: { $exists: false } }, { $set: { resolution } }, { returnDocument: 'after' })
        if (!report) return this.resolve(actorId, id, body)
      }
      if (body.decision === 'approve' && report.kind === 'attendance') {
        let applied = false
        for (let attempt = 0; attempt < 8; attempt++) {
          const row = await activities.findOne({ id: report.activityId })
          if (row?.updates?.some(item => item.reportId === id && item.type === 'attendance-corrected')) { applied = true; break }
          if ((row?.updates?.length || 0) >= 2000) {
            await reports.updateOne({ id, status: 'pending', resolution }, { $unset: { resolution: '' } })
            throw new HttpError(409, 'Hoạt động đạt giới hạn lịch sử; cần đối soát riêng trước khi sửa.')
          }
          if (!row || !member(row, report.reporterId) || JSON.stringify(snapshot(ownAttendance(row, report.reporterId))) !== JSON.stringify(report.attendanceSnapshot)) {
            await reports.updateOne({ id, status: 'pending', resolution }, { $unset: { resolution: '' } })
            throw new HttpError(409, 'Điểm danh đã thay đổi từ lúc gửi khiếu nại. Hãy tải lại và đối chiếu trạng thái mới.')
          }
          const now = new Date(), attendance = (row.attendance || []).filter(item => item.userId !== report.reporterId)
          attendance.push({ ...ownAttendance(row, report.reporterId), userId: report.reporterId, name: (await db.collection('users').findOne({ id: report.reporterId }, { projection: { name: 1 } }))?.name || 'Thành viên', status: body.status, updatedAt: now, updatedBy: actorId, correctionReportId: id })
          const result = await activities.updateOne({ id: row.id, version: row.version ?? { $exists: false } }, { $set: { attendance, updatedAt: now }, $inc: { version: 1 }, $push: { updates: { id: randomUUID(), type: 'attendance-corrected', reportId: id, actorId, userId: report.reporterId, previousStatus: report.attendanceSnapshot.status, status: body.status, text: body.note, createdAt: now } } })
          if (result.modifiedCount) { applied = true; break }
        }
        if (!applied) throw new HttpError(409, 'Hoạt động vừa thay đổi; thử lại cùng quyết định.')
      }
      await reports.updateOne({ id, status: 'pending', resolution }, { $set: { status: body.decision === 'approve' ? 'resolved' : 'dismissed', reviewNote: body.note, correctedStatus: report.kind === 'attendance' && body.decision === 'approve' ? body.status : null, resolvedAt: new Date(), resolvedBy: actorId }, $inc: { adminVersion: 1 } })
      const result = await reports.findOne({ id })
      await notifyResult(result)
      return view(result)
    },
  }
}
