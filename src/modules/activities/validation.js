import { HttpError } from '../../common/http-error.js'
import { planKeys, planningFields } from '../../common/activity-plan.js'
import { companionFields } from '../../common/companions.js'
import { preferences } from '../../common/preferences.js'
import { activityReadiness } from '../../common/activity-readiness.js'

export const activityCategories = ['Ăn uống', 'Thể thao', 'Du lịch', 'Giải trí', 'Học tập', 'Gaming', 'Âm nhạc', 'Nghệ thuật', 'Thiên nhiên', 'Tình nguyện', 'Công nghệ', 'Networking', 'Cà phê', 'Khám phá ẩm thực', 'Nấu ăn', 'Làm bánh', 'Picnic', 'Cắm trại', 'Trekking', 'Leo núi', 'Chạy bộ', 'Đi bộ', 'Đạp xe', 'Cầu lông', 'Bóng đá', 'Bóng rổ', 'Bóng chuyền', 'Bơi lội', 'Yoga', 'Gym', 'Tennis', 'Pickleball', 'Bóng bàn', 'Board game', 'Xem phim', 'Đọc sách', 'Nhiếp ảnh', 'Vẽ tranh', 'Thủ công', 'Làm gốm', 'Nhảy', 'Karaoke', 'Nhạc sống', 'Tham quan bảo tàng', 'Khám phá thành phố', 'Du lịch biển', 'Ngoại ngữ', 'Trao đổi ngôn ngữ', 'Workshop', 'Lập trình', 'Khởi nghiệp', 'Chăm sóc thú cưng', 'Làm vườn', 'Bảo vệ môi trường', 'Thiền', 'Khác']
export function activityFields(body, previous) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid activity body')
  const fields = {}
  const text = { address: [0, 200], province: [0, 100], district: [0, 100], ward: [0, 100], costNote: [0, 500], title: [3, 120], description: [1, 3000], location: [2, 200], meetingPoint: [0, 200] }
  const allowed = [...planKeys, 'companions', 'reservedSeats', 'initialFriendIds', ...Object.keys(text), 'category', 'startsAt', 'endsAt', 'registrationDeadline', 'financialConfig', 'participantPreferences', 'estimatedCost', 'minParticipants', 'maxParticipants', 'tags', 'requirements', 'plan', 'organizerType', 'coordinates', 'coverBase64', 'photosBase64']
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.includes(key)) throw new HttpError(400, `Unsupported activity field: ${key}`)
    if (planKeys.includes(key) || key === 'companions') continue
    if (key === 'initialFriendIds') {
      if (previous || !Array.isArray(value) || value.length > 50 || new Set(value).size !== value.length || value.some(id => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))) throw new HttpError(400, 'Invalid initialFriendIds')
      fields.initialFriendIds = value; continue
    }
    if (key === 'reservedSeats') {
      if (!Number.isInteger(value) || value < 0 || value > 999) throw new HttpError(400, 'Invalid reservedSeats')
      fields.reservedSeats = value; continue
    }
    if (key === 'registrationDeadline' && value === null) { fields[key] = null; continue }
    if (key === 'photosBase64') {
      if (!Array.isArray(value) || value.length > 6 || value.some(item => typeof item !== 'string' || !item.length || item.length > 13981016)) throw new HttpError(400, 'Provide up to 6 images, each at most 10 MB')
      if (body.coverBase64 !== undefined) throw new HttpError(400, 'Use photosBase64 or coverBase64, not both')
      continue
    }
    if (key === 'coverBase64') {
      if (typeof value !== 'string' || !value.length) throw new HttpError(400, 'Invalid cover image')
      continue
    }
    if (Object.hasOwn(text, key)) {
      if (typeof value !== 'string' || value.trim().length < text[key][0] || value.trim().length > text[key][1]) throw new HttpError(400, `Invalid ${key}`)
      fields[key] = value.trim()
    } else if (key === 'organizerType') {
      if (!['personal', 'business'].includes(value)) throw new HttpError(400, 'Invalid organizerType')
      fields[key] = value
    } else if (key === 'category') {
      if (!activityCategories.includes(value)) throw new HttpError(400, 'Invalid category')
      fields[key] = value
    } else if (key === 'participantPreferences') {
      fields[key] = preferences(value)
    } else if (key === 'financialConfig') {
      const amounts = ['estimatedCostPerMember', 'estimatedCostMin', 'estimatedCostMax', 'depositAmount', 'approvalThreshold']
      const keys = [...amounts, 'fundingMode', 'paymentDeadline', 'treasurerUserId', 'approvalRule']
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(item => !keys.includes(item)) ||
        !['FULL_PREPAYMENT', 'DEPOSIT'].includes(value.fundingMode) || !['MAJORITY', 'TWO_THIRDS', 'ALL'].includes(value.approvalRule) ||
        typeof value.treasurerUserId !== 'string' || !value.treasurerUserId.trim() || value.treasurerUserId.length > 100 ||
        amounts.some(item => value[item] !== undefined && (!Number.isInteger(value[item]) || value[item] < 0 || value[item] > 1000000000)) ||
        value.approvalThreshold === undefined ||
        (value.fundingMode === 'FULL_PREPAYMENT' ? value.estimatedCostPerMember === undefined :
          value.depositAmount === undefined || value.estimatedCostMin === undefined || value.estimatedCostMax === undefined || value.estimatedCostMin > value.estimatedCostMax || value.depositAmount > value.estimatedCostMax)) {
        throw new HttpError(400, 'Invalid financialConfig')
      }
      if (typeof value.paymentDeadline !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.paymentDeadline) ||
        !Number.isFinite(new Date(value.paymentDeadline).getTime()) || new Date(value.paymentDeadline).toISOString().replace('.000Z', 'Z') !== value.paymentDeadline.replace('.000Z', 'Z')) throw new HttpError(400, 'Invalid paymentDeadline')
      fields.financialConfig = { ...value, paymentDeadline: new Date(value.paymentDeadline) }
    } else if (key === 'startsAt' || key === 'endsAt' || key === 'registrationDeadline') {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) throw new HttpError(400, `${key} must be an ISO UTC date`)
      const date = new Date(value)
      if (!Number.isFinite(date.getTime()) || date.toISOString().replace('.000Z', 'Z') !== value.replace('.000Z', 'Z')) throw new HttpError(400, `Invalid ${key}`)
      fields[key] = date
    } else if (['estimatedCost', 'minParticipants', 'maxParticipants'].includes(key)) {
      const min = key === 'estimatedCost' ? 0 : 2
      const max = key === 'estimatedCost' ? 1000000000 : 1000
      if (!Number.isInteger(value) || value < min || value > max) throw new HttpError(400, `Invalid ${key}`)
      fields[key] = value
    } else if (key === 'coordinates') {
      if (value !== null && (!value || value.type !== 'Point' || !Array.isArray(value.coordinates) || value.coordinates.length !== 2 ||
        value.coordinates.some(item => typeof item !== 'number' || !Number.isFinite(item)) || Math.abs(value.coordinates[0]) > 180 || Math.abs(value.coordinates[1]) > 90)) throw new HttpError(400, 'Invalid coordinates')
      fields.coordinates = value === null ? null : { type: 'Point', coordinates: value.coordinates }
    } else {
      if (!Array.isArray(value) || value.length > 20 || value.some(item => typeof item !== 'string' || !item.trim() || item.trim().length > 200)) throw new HttpError(400, `Invalid ${key}`)
      fields[key] = [...new Set(value.map(item => item.trim()))]
    }
  }
  if (!Object.keys(body).length) throw new HttpError(400, 'No activity fields provided')
  if (body.companions !== undefined || fields.reservedSeats !== undefined) fields.companions = companionFields(body.companions !== undefined ? body.companions : (previous?.companions ?? []).slice(0, fields.reservedSeats ?? previous?.reservedSeats ?? 0), fields.reservedSeats ?? previous?.reservedSeats ?? 0)
  const merged = { ...previous, ...fields }
  for (const key of ['title', 'description', 'location', 'category', 'startsAt', 'endsAt', 'estimatedCost', 'maxParticipants']) {
    if (merged[key] === undefined) throw new HttpError(400, `Missing ${key}`)
  }
  if (merged.startsAt <= new Date() || merged.endsAt <= merged.startsAt) throw new HttpError(400, 'Activity must start in the future and end after it starts')
  if (merged.registrationDeadline && (merged.registrationDeadline <= new Date() || merged.registrationDeadline > merged.startsAt)) throw new HttpError(400, 'Registration deadline must be in the future and no later than activity start')
  if (merged.financialConfig && (merged.financialConfig.paymentDeadline <= new Date() || merged.financialConfig.paymentDeadline > merged.startsAt)) throw new HttpError(400, 'Payment deadline must be in the future and no later than activity start')
  const occupied = previous ? previous.memberCount + ((fields.reservedSeats ?? previous.reservedSeats ?? 0) - (previous.reservedSeats ?? 0)) : 1 + (fields.reservedSeats ?? 0)
  if (merged.maxParticipants < occupied) throw new HttpError(409, 'Capacity cannot be below the current member count')
  if ((merged.minParticipants ?? 2) > merged.maxParticipants) throw new HttpError(400, 'Số thành viên tối thiểu không được lớn hơn tối đa')
  if (merged.maxParticipants - (merged.reservedSeats ?? 0) < (merged.minParticipants ?? 2)) throw new HttpError(409, 'Cần chừa đủ chỗ cho số tài khoản tối thiểu; người đi cùng ngoài GoMate không tính vào điều kiện bắt đầu.')
  Object.assign(fields, planningFields(previous?.itinerary?.length && (fields.startsAt || fields.endsAt) && body.itinerary === undefined ? { ...body, itinerary: previous.itinerary } : body, merged))
  return fields
}

export function publicActivity(row) {
  const keys = ['memberAvatars', 'address', 'province', 'district', 'ward', 'costNote', 'reservedSeats', 'itinerary', 'planLink', 'planFile', 'id', 'hostId', 'hostName', 'title', 'description', 'category', 'location', 'organizerType', 'coordinates', 'startsAt', 'endsAt', 'registrationDeadline', 'meetingPoint', 'financialConfig', 'participantPreferences', 'estimatedCost', 'minParticipants', 'maxParticipants', 'memberCount', 'tags', 'requirements', 'plan', 'imageUrl', 'imageUrls', 'status', 'createdAt', 'updatedAt', 'version', 'startedAt', 'completedAt']
  return { ...Object.fromEntries([...keys, 'business', 'scheduleConfirmedAt', 'scheduleConfirmedBy'].filter(key => row[key] !== undefined).map(key => [key, row[key]])), readiness: activityReadiness(row) }
}
