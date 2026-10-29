import { randomUUID } from 'node:crypto'
import { HttpError } from '../../common/http-error.js'
import { createCommunityRepository } from '../community/repository.js'
import { createActivityRepository } from '../activities/repository.js'
import { activityReadiness } from '../../common/activity-readiness.js'
import { planningFields } from '../../common/activity-plan.js'
import { businessWallet } from './wallet.js'

const view = { _id: 0 }
export function createBusinessOperations(db) {
  const locations = db.collection('business_locations'), staff = db.collection('business_staff'), activities = db.collection('activities')
  const community = createCommunityRepository(db), repository = createActivityRepository(db)
  const notify = (userId, key, title, text, actorId) => community.notify(userId, { key, type: 'business-update', title, text, actorId })
  const page = async (collection, query, offset) => ({ items: await collection.find(query, { projection: view }).sort({ createdAt: -1, id: 1 }).skip(offset).limit(20).toArray(), total: await collection.countDocuments(query) })
  const verified = ownerId => db.collection('business_applications').findOne({ ownerId, status: 'approved' }, { projection: { id: 1 } })
  async function assigned(userId) {
    const grants = await staff.find({ userId, status: 'approved', acceptedAt: { $ne: null } }).toArray()
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
      status: row.status, startsAt: row.startsAt, endsAt: row.endsAt, locationId: row.businessLocationId || '', location: row.location, meetingPoint: row.meetingPoint, maxParticipants: row.maxParticipants, memberCount: row.memberCount, estimatedCost: row.estimatedCost, depositAmount: row.depositAmount || 0,
      managers: await staff.find({ownerId:row.hostId,groupIds:row.id,status:'approved',acceptedAt:{$ne:null}},{projection:{_id:0,userId:1,name:1,title:1}}).toArray(), attendance: row.attendance ?? [], readiness: activityReadiness(row), itineraryConfirmed: Boolean(row.scheduleConfirmedAt), scheduleConfirmedAt: row.scheduleConfirmedAt,
      depositMembers: members.map(member => { const receipt = receipts.find(item => item.userId === member.userId); return { id: member.userId, name: member.name, amount: receipt?.amount ?? row.depositAmount ?? 0, status: receipt?.status || (row.depositAmount ? 'pending' : 'not-required'), paidAt: receipt?.paidAt ?? null } }),
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
    async wallet(ownerId) {
      if (!await verified(ownerId)) throw new HttpError(403, 'Verified business required')
      return businessWallet(await activities.find({ hostId: ownerId, organizerType: 'business' }, { projection: { id: 1, title: 1, businessGroupName: 1, status: 1, businessReceipts: 1, joinRequests: 1 } }).toArray())
    },
    async listLocations(ownerId, offset) {
      if (await verified(ownerId)) return page(locations, { ownerId }, offset)
      const grants = await assigned(ownerId)
      return page(locations, { ownerId: { $in: grants.map(item => item.ownerId) } }, offset)
    },
    async saveLocation(ownerId, id, version, data) {
      if (!await verified(ownerId)) throw new HttpError(403, 'Verified business required')
      if (!id) { const row = { ...data, id: randomUUID(), ownerId, version: 1, createdAt: new Date(), updatedAt: new Date() }; await locations.insertOne(row); const { _id, ...result } = row; return result }
      const row = await locations.findOneAndUpdate({ id, ownerId, version }, { $set: { ...data, updatedAt: new Date() }, $inc: { version: 1 } }, { returnDocument: 'after', projection: view })
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
      return change(row, userId, version, { ...patch, businessPlanLocations:Object.fromEntries(normalized.flatMap((item,index)=>itinerary[index].locationId?[[item.id,itinerary[index].locationId]]:[])), ...(row.status === 'published' ? { scheduleConfirmedAt: null, scheduleConfirmedBy: null } : {}) }, 'business-plan-updated')
    },
    async recordDeposit(userId, id, version, memberId, status) {
      const row = await group(userId, id)
      if (!['published', 'in-progress'].includes(row.status) || !row.depositAmount) throw new HttpError(409, 'No deposit to record or group closed')
      if (!row.joinRequests?.some(member => member.userId === memberId && member.status === 'approved')) throw new HttpError(400, 'Only approved members have deposit records')
      const receipt = { userId: memberId, status, amount: row.depositAmount, paidAt: status === 'paid' ? new Date() : null, recordedBy: userId, recordedAt: new Date(), method: 'manual' }
      return change(row, userId, version, { businessReceipts: [...(row.businessReceipts ?? []).filter(item => item.userId !== memberId), receipt], ...(row.status === 'published' && status === 'pending' ? { scheduleConfirmedAt: null, scheduleConfirmedBy: null } : {}) }, 'business-deposit-recorded')
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
        if (!row.scheduleConfirmedAt) throw new HttpError(409, 'Confirm schedule first')
        const attendance = [{ userId: row.hostId, name: row.hostName }, ...row.joinRequests.filter(item => item.status === 'approved').map(item => ({ userId: item.userId, name: item.name }))].map(item => ({ ...item, status: 'unmarked' }))
        return change(row, userId, version, { status: 'in-progress', startedAt: new Date(), attendance }, 'started')
      }
      if (row.status !== 'in-progress' || !row.attendance?.length || row.attendance.some(item => item.status === 'unmarked')) throw new HttpError(409, 'Điểm danh đầy đủ trước khi kết thúc.')
      const result = await change(row, userId, version, { status: 'completed', completedAt: new Date() }, 'completed')
      await Promise.all(row.attendance.map(member => community.notify(member.userId, { key: 'business-completed:' + id, type: 'activity', title: 'Hoạt động đã kết thúc', text: row.title, activityId: id, actorId: userId })))
      return result
    },
    async attendance(userId, id, version, memberId, status) {
      const row = await group(userId, id)
      if (row.status !== 'in-progress' || !row.attendance?.some(item => item.userId === memberId)) throw new HttpError(409, 'Participant not found or group not running')
      return change(row, userId, version, { attendance: row.attendance.map(item => item.userId === memberId ? { ...item, status, updatedBy: userId, updatedAt: new Date() } : item) }, 'attendance-changed')
    },
    async listStaff(ownerId, offset, reviewing = false) { return page(staff, reviewing ? {} : { ownerId }, offset) },
    async incomingStaff(userId) { return { items: await staff.find({ userId, acceptedAt: null, status: 'pending' }, { projection: view }).toArray() } },
    async saveStaff(ownerId, id, version, data) {
      if (!await verified(ownerId)) throw new HttpError(403, 'Verified business required')
      const user = await db.collection('users').findOne({ email: data.email, email_verified: true }, { projection: { id: 1 } })
      if (!user || user.id === ownerId) throw new HttpError(400, 'Nhân sự cần tài khoản GoMate đã xác minh email riêng.')
      if (await activities.countDocuments({ id: { $in: data.groupIds }, hostId: ownerId, organizerType: 'business', status: { $nin: ['deleted', 'pending-review'] } }) !== data.groupIds.length) throw new HttpError(400, 'Chỉ phân công nhóm đã được duyệt thuộc doanh nghiệp.')
      const previous = id && await staff.findOne({ id, ownerId })
      if (id && (!previous || previous.version !== version)) throw new HttpError(409, 'Staff request changed')
      const business = await db.collection('business_applications').findOne({ ownerId, status: 'approved' }, { projection: { company: 1 } })
      const assignedGroups = await activities.find({ id: { $in: data.groupIds }, hostId: ownerId }, { projection: { title: 1 } }).toArray()
      const row = { ...data, businessName: business.company, groupNames: assignedGroups.map(item=>item.title), id: id || randomUUID(), ownerId, userId: user.id, status: 'pending', acceptedAt: null, version: (previous?.version ?? 0) + 1, updatedAt: new Date() }
      try {
        if (previous) { if (!(await staff.replaceOne({ id, ownerId, version }, { ...row, createdAt: previous.createdAt, history: [...(previous.history ?? []).slice(-199), { type: 'updated', actorId: ownerId, createdAt: new Date() }] })).matchedCount) throw new HttpError(409, 'Staff request changed') }
        else await staff.insertOne({ ...row, createdAt: new Date(), history: [{ type: 'requested', actorId: ownerId, createdAt: new Date() }] })
      } catch (error) { if (error.code === 11000) throw new HttpError(409, 'Nhân sự này đã có yêu cầu; hãy chỉnh sửa yêu cầu hiện tại.'); throw error }
      await notify(user.id, 'business-staff:' + row.id + ':' + row.version, 'Lời mời làm nhân sự doanh nghiệp', 'Bạn cần đồng ý trước khi Admin duyệt quyền quản lý nhóm.', ownerId)
      for(const admin of await db.collection('users').find({role:'admin'},{projection:{id:1}}).toArray()) await notify(admin.id,'business-staff-queue:'+row.id+':'+row.version,'Yêu cầu nhân sự doanh nghiệp',business.company+' · '+row.name,ownerId)
      return row
    },
    async acceptStaff(userId, id, version, accepted) {
      const row = await staff.findOneAndUpdate({ id, userId, version, status: 'pending', acceptedAt: null }, { $set: { acceptedAt: accepted ? new Date() : null, status: accepted ? 'pending' : 'declined', updatedAt: new Date() }, $inc: { version: 1 }, $push: { history: { type: accepted ? 'accepted' : 'declined', actorId: userId, createdAt: new Date() } } }, { returnDocument: 'after', projection: view })
      if (!row) throw new HttpError(409, 'Staff invitation changed')
      await notify(row.ownerId, 'business-staff-consent:' + id + ':' + row.version, accepted ? 'Nhân sự đã đồng ý' : 'Nhân sự đã từ chối', row.name, userId)
      if(accepted) for(const admin of await db.collection('users').find({role:'admin'},{projection:{id:1}}).toArray()) await notify(admin.id,'business-staff-ready:'+row.id+':'+row.version,'Nhân sự đã đồng ý, chờ duyệt',row.businessName+' · '+row.name,userId)
      return row
    },
    async decideStaff(actorId, id, version, status, note) {
      const row = await staff.findOneAndUpdate({ id, version, status: 'pending', ...(status === 'approved' ? { acceptedAt: { $ne: null } } : {}) }, { $set: { status, reviewNote: note, reviewedBy: actorId, reviewedAt: new Date() }, $inc: { version: 1 }, $push: { history: { type: status, actorId, note, createdAt: new Date() } } }, { returnDocument: 'after', projection: view })
      if (!row) throw new HttpError(409, 'Nhân sự chưa đồng ý hoặc yêu cầu đã thay đổi.')
      await Promise.all([row.ownerId, row.userId].map(userId => notify(userId, 'business-staff-review:' + id + ':' + row.version, status === 'approved' ? 'Quyền nhân sự đã được duyệt' : 'Yêu cầu nhân sự bị từ chối', note || row.name, actorId)))
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
