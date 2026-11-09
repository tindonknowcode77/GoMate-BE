import { randomUUID } from 'node:crypto'
import { HttpError } from '../../common/http-error.js'
import { createCommunityRepository } from '../community/repository.js'
import { createActivityRepository } from '../activities/repository.js'
import { activityReadiness } from '../../common/activity-readiness.js'
import { planningFields } from '../../common/activity-plan.js'
import { createFinanceRepository } from '../payment/finance.js'

const view = { _id: 0 }
function buildAttendanceRoster(row) {
  const existing = new Map((row.attendance ?? []).map(item => [item.userId, item]))
  const members = [{ userId: row.hostId, name: row.hostName }, ...(row.joinRequests ?? []).filter(item => item.status === 'approved').map(item => ({ userId: item.userId, name: item.name }))]
  return members.map(item => existing.get(item.userId) ? { ...existing.get(item.userId), name: item.name } : { ...item, status: 'unmarked' })
}
export function createBusinessOperations(db) {
  const locations = db.collection('business_locations'), staff = db.collection('business_staff'), activities = db.collection('activities')
  const bankAccounts = db.collection('business_bank_accounts'), finance = createFinanceRepository(db)
  const community = createCommunityRepository(db), repository = createActivityRepository(db)
  const notify = (userId, key, title, text, actorId, activityId) => community.notify(userId, { key, type: 'business-update', title, text, actorId, ...(activityId ? { activityId } : {}) })
  const page = async (collection, query, offset) => ({ items: await collection.find(query, { projection: view }).sort({ createdAt: -1, id: 1 }).skip(offset).limit(20).toArray(), total: await collection.countDocuments(query) })
  const verified = ownerId => db.collection('business_applications').findOne({ ownerId, status: 'approved' }, { projection: { id: 1 } })
  async function assigned(userId) {
    const grants = await staff.find({ userId, status: 'approved', $or: [{ provisionedAt: { $ne: null } }, { acceptedAt: { $ne: null } }] }).toArray()
    const owners = await db.collection('business_applications').find({ ownerId: { $in: grants.map(item => item.ownerId) }, status: 'approved' }, { projection: { ownerId: 1 } }).toArray()
    return grants.filter(item => owners.some(owner => owner.ownerId === item.ownerId))
  }
  async function group(userId, id) {
    const row = await activities.findOne({ id, organizerType: 'business', status: { $nin: ['deleted', 'pending-review'] } }, { projection: { planFileData: 0 } })
    if (!row || !await verified(row.hostId)) throw new HttpError(404, 'Group not found')
    if (row.hostId !== userId && !(await assigned(userId)).some(grant => grant.ownerId === row.hostId && grant.groupIds.includes(id))) throw new HttpError(403, 'Group access denied')
    return row
  }
  async function groupView(row) {
    const members = (row.joinRequests ?? []).filter(item => item.status === 'approved')
    const receipts = row.businessReceipts ?? []
    return { id: row.id, ownerId: row.hostId, version: row.version, name: row.businessGroupName || row.title, campaignTitle: row.businessCampaignTitle || row.title, promotionalPostTitle: row.businessCampaignTitle || row.title, promotionalPostId: row.businessPostId,
      status: row.status, startsAt: row.startsAt, endsAt: row.endsAt, locationId: row.businessLocationId || '', location: row.location, meetingPoint: row.meetingPoint, maxParticipants: row.maxParticipants, memberCount: row.memberCount, estimatedCost: row.estimatedCost, depositAmount: row.depositAmount || 0, autoApproveMembers: row.autoApproveMembers === true,
      managers: await staff.find({ownerId:row.hostId,groupIds:row.id,status:'approved',$or:[{provisionedAt:{$ne:null}},{acceptedAt:{$ne:null}}]},{projection:{_id:0,userId:1,name:1,title:1}}).toArray(), attendance: row.attendance?.length ? row.attendance : buildAttendanceRoster(row), readiness: activityReadiness(row), itineraryConfirmed: Boolean(row.scheduleConfirmedAt), scheduleConfirmedAt: row.scheduleConfirmedAt,
      depositMembers: members.map(member => { const receipt = receipts.find(item => item.userId === member.userId); return { id: member.userId, name: member.name, amount: receipt?.status === 'paid' ? receipt.amount : row.depositAmount ?? 0, status: receipt?.status === 'paid' ? 'paid' : row.depositAmount ? 'pending' : 'not-required', paidAt: receipt?.paidAt ?? null, verified: Boolean(receipt?.verified) } }),
      itinerary: (row.itinerary ?? []).map(item => ({ ...item, locationId: row.businessPlanLocations?.[item.id] || '', location: item.place, notes: item.note })), notifications: row.businessOffers ?? [], requests: (row.joinRequests ?? []).filter(item => item.status === 'pending') }
  }
  async function change(row, actorId, version, patch, type) {
    if (version !== row.version) throw new HttpError(409, 'Group changed. Reload before saving.')
    if ((row.updates?.length ?? 0) >= 2000) throw new HttpError(409, 'Activity update limit reached')
    const event = { id: randomUUID(), type, actorId, createdAt: new Date() }
    const updated = await repository.lifecycle(row, row.hostId, patch, event)
    if (!updated) throw new HttpError(409, 'Group changed. Reload before saving.')
    if (['schedule-confirmed','started','business-plan-updated'].includes(type)) await Promise.all((row.joinRequests ?? []).filter(item=>item.status==='approved').map(member=>community.notify(member.userId,{key:'business-event:'+event.id,type:'activity',title:type==='started'?'Hoạt động đã bắt đầu':type==='business-plan-updated'?'Doanh nghiệp đã cập nhật lịch trình':'Host đã chốt lịch đi',text:row.title,activityId:row.id,actorId})))
    return groupView(updated)
  }
  return {
    assigned,
    async wallet(ownerId) { return finance.businessWallet(ownerId) },
    async saveBankAccount(ownerId, { bankId, accountNo, accountName, branch = '' } = {}) {
      if (!await verified(ownerId)) throw new HttpError(403, 'Verified business required')
      const cleanBankId = String(bankId || '').trim().toUpperCase()
      const cleanAccountNo = String(accountNo || '').replace(/\s+/g, '')
      const cleanAccountName = String(accountName || '').trim().toUpperCase()
      const cleanBranch = String(branch || '').trim().slice(0, 120)
      if (!cleanBankId || cleanBankId.length > 20) throw new HttpError(400, 'Vui lòng chọn hoặc nhập mã ngân hàng hợp lệ.')
      if (!/^\d{6,25}$/.test(cleanAccountNo)) throw new HttpError(400, 'Số tài khoản ngân hàng phải gồm từ 6 đến 25 chữ số.')
      if (!cleanAccountName || cleanAccountName.length < 3 || cleanAccountName.length > 120) throw new HttpError(400, 'Vui lòng nhập tên chủ tài khoản thụ hưởng hợp lệ.')
      const now = new Date()
      const record = {
        ownerId,
        bankId: cleanBankId,
        accountNo: cleanAccountNo,
        accountName: cleanAccountName,
        branch: cleanBranch,
        updatedAt: now,
      }
      await bankAccounts.updateOne({ ownerId }, { $set: record, $setOnInsert: { createdAt: now } }, { upsert: true })
      return record
    },
    async requestPayout(ownerId, body) { return finance.requestPayout(ownerId, body) },
    async listLocations(ownerId, offset) {
      if (await verified(ownerId)) return page(locations, { ownerId }, offset)
      const grants = await assigned(ownerId)
      return page(locations, { ownerId: { $in: grants.map(item => item.ownerId) } }, offset)
    },
    async saveLocation(ownerId, id, version, data) {
      if (!await verified(ownerId)) throw new HttpError(403, 'Verified business required')
      if (!id) { const row = { ...data, id: randomUUID(), ownerId, version: 1, createdAt: new Date(), updatedAt: new Date() }; await locations.insertOne(row); const { _id, ...result } = row; return result }
      const row = await locations.findOneAndUpdate({ id, ownerId, version }, { $set: { ...data, updatedAt: new Date() }, ...(!Number.isFinite(data.latitude)?{$unset:{latitude:'',longitude:''}}:{}), $inc: { version: 1 } }, { returnDocument: 'after', projection: view })
      if (!row) throw new HttpError(409, 'Location not found or changed')
      return row
    },
    async deleteLocation(ownerId, id, version) {
      if (await db.collection('business_posts').findOne({ ownerId, status: { $in: ['pending', 'publishing'] }, 'groups.locationId': id })) throw new HttpError(409, 'Địa điểm đang được dùng trong bài chờ duyệt.')
      if (!(await locations.deleteOne({ ownerId, id, version })).deletedCount) throw new HttpError(409, 'Location not found or changed')
      return { deleted: true }
    },
    async listGroups(userId, offset) {
      const grants = await assigned(userId)
      const query = { organizerType: 'business', status: { $nin: ['deleted', 'pending-review'] }, $or: [{ hostId: userId }, ...grants.map(grant => ({ hostId: grant.ownerId, id: { $in: grant.groupIds } }))] }
      const rows = await activities.find(query, { projection: { planFileData: 0 } }).sort({ startsAt: 1, id: 1 }).skip(offset).limit(20).toArray()
      return { items: await Promise.all(rows.map(groupView)), total: await activities.countDocuments(query) }
    },
    async getGroup(userId, id) { return groupView(await group(userId, id)) },
    async saveSettings(userId, id, version, data) {
      const row = await group(userId, id)
      if (row.hostId !== userId) throw new HttpError(403, 'Chỉ chủ doanh nghiệp được thay đổi cài đặt nhóm.')
      if (row.status !== 'published' || new Date(row.startsAt) <= new Date()) throw new HttpError(409, 'Chỉ thay đổi cài đặt trước khi nhóm bắt đầu.')
      if (data.depositAmount !== undefined && data.depositAmount > row.estimatedCost) throw new HttpError(400, 'Tiền cọc không được vượt chi phí mỗi người.')
      if (data.depositAmount !== undefined && data.depositAmount !== row.depositAmount && (row.businessReceipts?.some(item => item.status === 'paid' && item.verified) || await db.collection('finance_escrows').findOne({ _id: id, 'lots.0': { $exists: true } }))) throw new HttpError(409, 'Không thể thay đổi mức tiền cọc khi đã có thành viên thanh toán cọc xác thực.')
      const patch = {}
      if (data.autoApproveMembers !== undefined) patch.autoApproveMembers = data.autoApproveMembers
      if (data.depositAmount !== undefined) { patch.depositAmount = data.depositAmount; patch.business = { ...row.business, depositAmount: data.depositAmount }; patch.scheduleConfirmedAt = null; patch.scheduleConfirmedBy = null }
      const result = await change(row, userId, version, patch, 'business-settings-updated')
      if (data.depositAmount !== undefined && data.depositAmount !== row.depositAmount) await db.collection('payments').updateMany({ activityId: id, type: 'activity_deposit', status: 'pending', amount: { $ne: data.depositAmount } }, { $set: { status: 'cancelled', cancellationReason: 'deposit-changed', updatedAt: new Date() }, $unset: { activeKey: '' } })
      return result
    },
    async savePlan(userId, id, version, itinerary) {
      const row = await group(userId, id)
      if (!['published', 'in-progress'].includes(row.status)) throw new HttpError(409, 'Group is closed')
      const date = new Date(+new Date(row.startsAt) + 7 * 3600000).toISOString().slice(0, 10)
      if (!Array.isArray(itinerary) || itinerary.length > 60) throw new HttpError(400, 'Provide at most 60 itinerary items')
      if (itinerary.some(item=>!item || typeof item!=='object' || Array.isArray(item) || Object.keys(item).some(key=>!['id','date','time','title','location','locationId','notes','place','note'].includes(key)))) throw new HttpError(400,'Invalid itinerary item')
      for (const item of itinerary) if(item.locationId && !await locations.findOne({id:item.locationId,ownerId:row.hostId})) throw new HttpError(400,'Invalid itinerary location')
      const normalized = itinerary.map(item => ({ id: typeof item.id==='string' && /^[a-zA-Z0-9_-]{1,100}$/.test(item.id) ? item.id : randomUUID(), date: item.date || date, time: item.time, title: item.title, place: item.location || item.place || '', note: item.notes || item.note || '' }))
      const patch = planningFields({ itinerary: normalized }, row)
      for (const step of patch.itinerary) { const source=itinerary[normalized.findIndex(item=>item.id===step.id)]; if(source?.locationId) {const place=await locations.findOne({id:source.locationId,ownerId:row.hostId});step.place=(place.name+' · '+place.address).slice(0,200);} }
      return change(row, userId, version, { ...patch, lastPlanUpdatedAt: new Date(), businessPlanLocations:Object.fromEntries(normalized.flatMap((item,index)=>itinerary[index].locationId?[[item.id,itinerary[index].locationId]]:[])), ...(row.status === 'published' ? { scheduleConfirmedAt: null, scheduleConfirmedBy: null } : {}) }, 'business-plan-updated')
    },
    async recordDeposit(userId, id, version, memberId, status) {
      const row = await group(userId, id)
      if (!['published', 'in-progress'].includes(row.status) || !row.depositAmount) throw new HttpError(409, 'No deposit to record or group closed')
      if (!row.joinRequests?.some(member => member.userId === memberId && member.status === 'approved')) throw new HttpError(400, 'Only approved members have deposit records')
      if (status === 'pending' && row.businessReceipts?.some(item => item.userId === memberId && item.status === 'paid' && item.verified)) throw new HttpError(409, 'Không thể hủy trạng thái cọc đã được hệ thống thanh toán xác thực.')
      const receipt = { userId: memberId, status, amount: row.depositAmount, paidAt: status === 'paid' ? new Date() : null, recordedBy: userId, recordedAt: new Date(), method: 'manual' }
      const updated = await change(row, userId, version, { businessReceipts: [...(row.businessReceipts ?? []).filter(item => item.userId !== memberId), receipt], ...(row.status === 'published' && status === 'pending' ? { scheduleConfirmedAt: null, scheduleConfirmedBy: null } : {}) }, 'business-deposit-recorded')
      if (status === 'paid') await community.notify(memberId, { key: 'deposit-confirmed:' + id + ':' + memberId + ':' + updated.version, type: 'activity', title: 'Đã xác nhận tiền cọc', text: row.title + ' · ' + row.depositAmount.toLocaleString('vi-VN') + 'đ', activityId: id, actorId: userId })
      return updated
    },
    async decideMember(userId, id, version, requestId, status) {
      const row = await group(userId, id)
      if (row.version !== version) throw new HttpError(409, 'Group changed')
      const request = await repository.changeJoinRequest(id, { hostId: row.hostId, requestId, status, version })
      if (!request) throw new HttpError(409, 'Request changed, group full or no longer upcoming')
      await community.notify(request.userId, { key: 'business-decision:' + request.id + ':' + status, type: 'activity', title: status === 'approved' ? 'Yêu cầu đã được duyệt' : 'Yêu cầu chưa được duyệt', text: row.title, activityId: id, actorId: userId })
      return groupView(await repository.get(id))
    },
    async offer(userId, id, version, data) {
      const row = await group(userId, id)
      if (!['published', 'in-progress'].includes(row.status)) throw new HttpError(409, 'Group closed')
      const existing = row.businessOffers?.find(item => item.clientId === data.clientId)
      if (existing && (existing.title !== data.title || existing.body !== data.body || existing.expiresAt !== data.expiresAt)) throw new HttpError(409, 'Request ID was already used')
      if (!existing && (row.businessOffers?.length ?? 0) >= 100) throw new HttpError(409, 'Offer limit reached')
      const notice = existing || { ...data, id: randomUUID(), actorId: userId, sentAt: new Date(), recipients: (row.joinRequests ?? []).filter(item => item.status === 'approved').length }
      if (!existing) await change(row, userId, version, { businessOffers: [...(row.businessOffers ?? []), notice] }, 'business-offer')
      await Promise.all((row.joinRequests ?? []).filter(item => item.status === 'approved').map(member => community.notify(member.userId, { key: 'offer:' + notice.id, type: 'activity', title: data.title, text: data.body, activityId: id, actorId: userId })))
      return groupView(await repository.get(id))
    },
    async editOffer(userId, id, version, offerId, data) {
      const row = await group(userId, id)
      if (!['published', 'in-progress'].includes(row.status)) throw new HttpError(409, 'Group closed')
      const existing = row.businessOffers?.find(item=>item.id===offerId)
      if (!existing) throw new HttpError(404, 'Offer not found')
      const updated = {...existing,...data,updatedAt:new Date(),updatedBy:userId}
      const result=await change(row,userId,version,{businessOffers:row.businessOffers.map(item=>item.id===offerId?updated:item)},'business-offer-updated')
      await db.collection('notifications').updateMany({key:'offer:'+offerId,activityId:id},{$set:{title:data.title,text:data.body,readAt:null,updatedAt:new Date()}})
      return result
    },
    async action(userId, id, version, action) {
      const row = await group(userId, id)
      if (action === 'confirm-schedule' || action === 'start') {
        if (row.status !== 'published' || row.endsAt <= new Date()) throw new HttpError(409, 'Group is not upcoming')
        const readiness = activityReadiness(row)
        if (!readiness.ready) throw new HttpError(409, readiness.reason)
        if (action === 'confirm-schedule') {
          if (row.startsAt <= new Date()) throw new HttpError(409, 'Adjust the schedule first')
          if (row.depositAmount && row.joinRequests.filter(item => item.status === 'approved').some(member => !row.businessReceipts?.some(receipt => receipt.userId === member.userId && receipt.status === 'paid'))) throw new HttpError(409, 'Còn thành viên chưa được ghi nhận tiền cọc.')
          return change(row, userId, version, { scheduleConfirmedAt: new Date(), scheduleConfirmedBy: userId }, 'schedule-confirmed')
        }
        const now = new Date()
        const attendance = buildAttendanceRoster(row)
        return change(row, userId, version, { status: 'in-progress', startedAt: now, scheduleConfirmedAt: row.scheduleConfirmedAt || now, scheduleConfirmedBy: row.scheduleConfirmedBy || userId, attendance }, 'started')
      }
      if (row.status !== 'in-progress') throw new HttpError(409, 'Group is not running')
      const now = new Date()
      const attendance = buildAttendanceRoster(row).map(item => item.status === 'unmarked' ? { ...item, status: 'present', updatedBy: userId, updatedAt: now } : item)
      const result = await change(row, userId, version, { status: 'completed', completedAt: now, attendance }, 'completed')
      await Promise.all(attendance.map(member => community.notify(member.userId, { key: 'business-completed:' + id, type: 'activity', title: 'Hoạt động đã kết thúc', text: row.title, activityId: id, actorId: userId })))
      return result
    },
    async attendance(userId, id, version, memberId, status) {
      const row = await group(userId, id)
      const roster = buildAttendanceRoster(row)
      const correction = row.status === 'completed' && row.autoCompletedAt && Date.now() - new Date(row.autoCompletedAt).getTime() < 86400000
      if (!['published', 'in-progress'].includes(row.status) && !correction || !roster.some(item => item.userId === memberId)) throw new HttpError(409, 'Participant not found or group not running')
      if (correction && (roster.find(item => item.userId === memberId)?.status !== 'unmarked' || status === 'unmarked')) throw new HttpError(409, 'Chỉ bổ sung điểm danh còn thiếu sau khi tự kết thúc.')
      const result = await change(row, userId, version, { attendance: roster.map(item => item.userId === memberId ? { ...item, status, updatedBy: userId, updatedAt: new Date() } : item) }, 'attendance-changed')
      if (status === 'absent' && memberId !== userId) await community.notify(memberId, { key: `attendance-absent:${id}:${memberId}:${result.version}`, type: 'activity', title: 'Trạng thái điểm danh: Vắng mặt', text: `Bạn được ghi nhận vắng mặt tại ${row.title}. Nếu có nhầm lẫn, hãy phản hồi trong nhóm hoặc gửi khiếu nại trong Ví.`, activityId: id, actorId: userId })
      return result
    },
    async listStaff(ownerId, offset, reviewing = false) { return page(staff, reviewing ? {} : { ownerId }, offset) },
    async saveStaff(ownerId, id, version, { passwordHash, ...data }) {
      if (!await verified(ownerId)) throw new HttpError(403, 'Verified business required')
      const previous = id && await staff.findOne({ id, ownerId })
      if (id && (!previous || previous.version !== version)) throw new HttpError(409, 'Staff account changed')
      if (await activities.countDocuments({ id: { $in: data.groupIds }, hostId: ownerId, organizerType: 'business', status: { $nin: ['deleted', 'pending-review'] } }) !== data.groupIds.length) throw new HttpError(400, 'Only assign approved groups belonging to this business')
      const users = db.collection('users')
      let user, createdUser = false
      if (previous) {
        if (data.email !== previous.email) throw new HttpError(400, 'Cannot change the account identity of an employee')
        user = await users.findOne({ id: previous.userId })
        if (!user || user.id === ownerId) throw new HttpError(409, 'Employee account not found')
      } else {
        if (!passwordHash) throw new HttpError(400, 'Employee password required')
        if (await users.findOne({ email: data.email })) throw new HttpError(409, 'Email already registered; use a new employee email')
        user = { id: randomUUID(), email: data.email, name: data.name, password_hash: passwordHash, email_verified: true, role: 'user', businessManagedBy: ownerId, created_at: new Date() }
        try { await users.insertOne(user); createdUser = true }
        catch (error) { if (error.code === 11000) throw new HttpError(409, 'Email already registered'); throw error }
      }
      const business = await db.collection('business_applications').findOne({ ownerId, status: 'approved' }, { projection: { company: 1 } })
      const assignedGroups = await activities.find({ id: { $in: data.groupIds }, hostId: ownerId }, { projection: { id: 1, title: 1 } }).toArray()
      const now = new Date()
      const row = { ...data, businessName: business.company, groupNames: assignedGroups.map(item => item.title), id: id || randomUUID(), ownerId, userId: user.id, status: 'approved', provisionedAt: previous?.provisionedAt || now, acceptedAt: previous?.acceptedAt || null, version: (previous?.version ?? 0) + 1, updatedAt: now }
      try {
        if (previous) {
          if (!(await staff.replaceOne({ id, ownerId, version }, { ...row, createdAt: previous.createdAt, history: [...(previous.history ?? []).slice(-199), { type: 'updated', actorId: ownerId, createdAt: now }] })).matchedCount) throw new HttpError(409, 'Staff account changed')
        } else await staff.insertOne({ ...row, createdAt: now, history: [{ type: 'provisioned', actorId: ownerId, createdAt: now }] })
      } catch (error) {
        if (createdUser) await users.deleteOne({ id: user.id, businessManagedBy: ownerId })
        if (error.code === 11000) throw new HttpError(409, 'Employee already belongs to this business')
        throw error
      }
      await notify(user.id, 'business-staff:' + row.id + ':' + row.version, 'Phân công nhân viên doanh nghiệp', assignedGroups.length ? 'Bạn được phân công quản lý: ' + assignedGroups.map(item => item.title).join(', ') : 'Bạn có thể quản lý ngay các nhóm được doanh nghiệp phân công.', ownerId, assignedGroups[0]?.id)
      if (createdUser) await community.notify(user.id, { key: 'staff-welcome:' + row.id, type: 'activity', title: 'Tài khoản Nhân sự doanh nghiệp (' + business.company + ')', text: assignedGroups.length ? 'Bạn đã được cấp tài khoản nhân sự và phân công quản lý: ' + assignedGroups.map(item => item.title).join(', ') : 'Tài khoản nhân sự của bạn tại ' + business.company + ' đã sẵn sàng trên ứng dụng GoMate.', ...(assignedGroups[0]?.id ? { activityId: assignedGroups[0].id } : {}), actorId: ownerId })
      for (const item of assignedGroups.filter(group => !previous?.groupIds?.includes(group.id))) await community.notify(user.id, { key: 'staff-assigned:' + row.id + ':' + item.id + ':' + row.version, type: 'activity', title: 'Bạn được phân công quản lý nhóm', text: item.title + ' · ' + business.company, activityId: item.id, actorId: ownerId })
      return row
    },
    async removeStaff(ownerId, id, version) {
      const row = await staff.findOneAndUpdate({ id, ownerId, version }, { $set: { status: 'revoked', updatedAt: new Date() }, $inc: { version: 1 }, $push: { history: { type: 'revoked', actorId: ownerId, createdAt: new Date() } } }, { returnDocument: 'after', projection: view })
      if (!row) throw new HttpError(409, 'Staff request changed')
      await notify(row.userId, 'business-staff-revoked:' + id + ':' + row.version, 'Quyền nhân sự đã được thu hồi', row.name, ownerId)
      return row
    },
  }
}
