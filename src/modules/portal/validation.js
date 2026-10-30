import { HttpError } from '../../common/http-error.js'
import { activityFields } from '../activities/validation.js'
import { businessIndustries } from './business-options.js'

export function fields(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key))) throw new HttpError(400, 'Invalid request fields')
}
export function text(value, max, optional = false) {
  if (optional && (value === undefined || value === '')) return ''
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new HttpError(400, 'Missing or invalid text')
  return value.trim()
}
export function version(value) { if (!Number.isInteger(value) || value < 0) throw new HttpError(400, 'Provide the current version'); return value }
export function email(value) {
  const result = text(value, 254).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw new HttpError(400, 'Invalid email')
  return result
}
export function phone(value) {
  const result = text(value, 40).replace(/[\s().-]/g, '')
  if (!/^\+?\d{9,15}$/.test(result)) throw new HttpError(400, 'Invalid phone number')
  return result
}
export function applicationFields(body, parseDocument) {
  fields(body, ['company', 'website', 'category', 'taxId', 'address', 'representativeName', 'representativeTitle', 'representativeEmail', 'representativePhone', 'document', 'version', 'accountType', 'country', 'certificateNumber', 'supplementalDocument'])
  const modern = body.accountType !== undefined || body.certificateNumber !== undefined || body.country !== undefined
  const taxId = text(body.taxId, 20, modern).replace(/[-\s]/g, '')
  if ((!modern || taxId) && !/^\d{10}(?:\d{3})?$/.test(taxId)) throw new HttpError(400, 'Mã số thuế cần 10 hoặc 13 chữ số.')
  let identity = {}
  if (modern) {
    if (!['business', 'individual'].includes(body.accountType) || body.country !== 'VN') throw new HttpError(400, 'Loại tài khoản hoặc quốc gia không hợp lệ.')
    if (!businessIndustries.includes(body.category)) throw new HttpError(400, 'Vui lòng chọn một ngành trong danh sách.')
    const certificateNumber = text(body.certificateNumber, 60).toUpperCase()
    if (!/^[A-Z0-9][A-Z0-9.\/-]{1,59}$/.test(certificateNumber)) throw new HttpError(400, 'Vui lòng nhập số giấy chứng nhận chính xác.')
    identity = { accountType: body.accountType, country: 'VN', certificateNumber }
  }
  const website = text(body.website, 500, true)
  if (website) { let url; try { url = new URL(website) } catch { throw new HttpError(400, 'Invalid website URL') }; if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new HttpError(400, 'Invalid website URL') }
  return { company: text(body.company, 150), category: text(body.category, 100), taxId, website, address: text(body.address, 500),
    representativeName: text(body.representativeName, 120), representativeTitle: text(body.representativeTitle, 80), representativeEmail: email(body.representativeEmail), representativePhone: phone(body.representativePhone),
    ...identity, schemaVersion: modern ? 3 : 2, ...(body.document !== undefined ? { document: parseDocument(body.document) } : {}), ...(body.supplementalDocument !== undefined ? { supplementalDocument: parseDocument(body.supplementalDocument) } : {}), ...(body.version !== undefined ? { version: version(body.version) } : {}) }
}
export function postFields(body) {
  fields(body, ['title', 'copy', 'badge', 'discount', 'border', 'premium', 'event', 'groups', 'discountPercent', 'offer', 'offerTerms', 'version'])
  const title = text(body.title, 120), copy = text(body.copy, 3000)
  if (typeof body.premium !== 'boolean' || !['Glow', 'Soft', 'Solid'].includes(body.border)) throw new HttpError(400, 'Invalid post styling')
  const discountPercent = body.discountPercent ?? 0
  if (!Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent > 100) throw new HttpError(400, 'Discount must be an integer from 0 to 100')
  if (body.event && body.groups) throw new HttpError(400, 'Use event or groups')
  const event = value => {
    fields(value, ['category', 'location', 'province', 'address', 'meetingPoint', 'startsAt', 'endsAt', 'registrationDeadline', 'estimatedCost', 'minParticipants', 'maxParticipants', 'itinerary', 'plan', 'planLink', 'coordinates'])
    return activityFields({ ...value, title, description: copy })
  }
  let groups
  if (body.groups !== undefined) {
    if (!Array.isArray(body.groups) || !body.groups.length || body.groups.length > 20) throw new HttpError(400, 'Provide 1–20 groups')
    groups = body.groups.map(group => {
      fields(group, ['name', 'locationId', 'depositAmount', 'event'])
      const data = event(group.event), depositAmount = group.depositAmount ?? 0
      if (!Number.isInteger(depositAmount) || depositAmount < 0 || depositAmount > data.estimatedCost) throw new HttpError(400, 'Deposit must be between zero and the published price')
      return { name: text(group.name, 80), locationId: text(group.locationId, 100, true), depositAmount, event: data }
    })
  }
  return { title, copy, premium: body.premium, border: body.border, badge: text(body.badge, 60, true), discount: text(body.discount, 60, true), discountPercent, offer: text(body.offer, 200, true), offerTerms: text(body.offerTerms, 500, true),
    ...(body.event ? { event: event(body.event) } : {}), ...(groups ? { groups } : {}) }
}

export function locationFields(body) {
  fields(body, ['name', 'address', 'city', 'phone', 'latitude', 'longitude', 'mapX', 'mapY', 'version'])
  if ((body.latitude !== undefined || body.longitude !== undefined) && (![body.latitude, body.longitude].every(Number.isFinite) || Math.abs(body.latitude) > 90 || Math.abs(body.longitude) > 180)) throw new HttpError(400, 'Invalid coordinates')
  for (const key of ['mapX', 'mapY']) if (body[key] !== undefined && (!Number.isFinite(body[key]) || body[key] < 0 || body[key] > 100)) throw new HttpError(400, 'Invalid map position')
  return { name: text(body.name, 150), address: text(body.address, 300), city: text(body.city, 100), phone: body.phone ? phone(body.phone) : '', ...(Number.isFinite(body.latitude)?{latitude: body.latitude, longitude: body.longitude}:{}), mapX: body.mapX ?? 50, mapY: body.mapY ?? 50 }
}
