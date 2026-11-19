import { HttpError } from '../../common/http-error.js'
import { fields, text, postFields, applicationFields } from './validation.js'

const statuses = {
  users: ['active', 'banned', 'pending'], businesses: ['pending', 'approved', 'rejected'],
  posts: ['pending', 'approved', 'rejected', 'withdrawn', 'publishing'],
  reports: ['pending', 'resolved', 'dismissed'], tickets: ['open', 'closed'],
}

export function adminText(value, label, max, { optional = false, min = 1 } = {}) {
  if (optional && value === undefined) return ''
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new HttpError(400, `${label} không hợp lệ.`)
  const result = value.trim()
  if (result.length > max || result.length < (optional ? 0 : min)) throw new HttpError(400, `${label} cần ${optional ? 0 : min}–${max} ký tự.`)
  return result
}

export function adminId(value) {
  const result = text(value, 100)
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(result)) throw new HttpError(400, 'ID không hợp lệ.')
  return result
}

export function adminQuery(kind, query) {
  const sortable = ['users', 'posts'].includes(kind)
  fields(query, ['page', 'q', 'status', 'role', ...(sortable ? ['dateFrom', 'dateTo', 'sortBy', 'sortDirection'] : [])])
  const rawPage = query.page === undefined ? '1' : query.page
  if (typeof rawPage !== 'string' || !/^[1-9]\d{0,4}$/.test(rawPage) || Number(rawPage) > 10000) throw new HttpError(400, 'Trang phải là số nguyên từ 1 đến 10000.')
  const q = adminText(query.q, 'Từ khóa', 120, { optional: true })
  const status = adminText(query.status, 'Trạng thái', 30, { optional: true })
  if (status && !statuses[kind]?.includes(status)) throw new HttpError(400, 'Trạng thái lọc không hợp lệ cho mục này.')
  const role = adminText(query.role, 'Vai trò', 100, { optional: true })
  if (role && (kind !== 'users' || !['admin', 'business', 'business-staff', 'staff', 'host', 'user'].includes(role) && !/^custom-[0-9a-f-]{36}$/.test(role))) throw new HttpError(400, 'Vai trò lọc không hợp lệ cho mục này.')
  const options = {}
  for (const key of ['dateFrom', 'dateTo']) {
    if (query[key] === undefined) continue
    const value = query[key]
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new HttpError(400, 'Invalid date filter')
    options[key] = value
  }
  if (options.dateFrom && options.dateTo && options.dateFrom > options.dateTo) throw new HttpError(400, 'Invalid date range')
  if (query.sortBy !== undefined) {
    if (!(kind === 'users' ? ['createdAt', 'name', 'email', 'role', 'status'] : ['createdAt', 'title', 'status']).includes(query.sortBy)) throw new HttpError(400, 'Invalid sort field')
    options.sortBy = query.sortBy
  }
  if (query.sortDirection !== undefined) {
    if (!['asc', 'desc'].includes(query.sortDirection)) throw new HttpError(400, 'Invalid sort direction')
    options.sortDirection = query.sortDirection
  }
  return { page: Number(rawPage), q, status, ...(role ? { role } : {}), ...options }
}

export function adminPostFields(body) {
  fields(body, ['title', 'copy', 'badge', 'discount', 'border', 'premium', 'event', 'groups', 'discountPercent', 'offer', 'offerTerms'])
  if (body.discountPercent !== undefined && (!Number.isInteger(body.discountPercent) || body.discountPercent < 0 || body.discountPercent > 100)) throw new HttpError(400, 'Giảm giá phải là số nguyên từ 0 đến 100.')
  const data = { ...body }
  for (const [key, label, max, optional] of [['title', 'Tiêu đề', 120], ['copy', 'Nội dung', 3000], ['badge', 'Nhãn', 60, true], ['discount', 'Giảm giá', 60, true], ['offer', 'Ưu đãi', 200, true], ['offerTerms', 'Điều kiện ưu đãi', 500, true]]) data[key] = adminText(body[key], label, max, { optional })
  return postFields(data)
}

export function adminApplicationFields(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Hồ sơ doanh nghiệp phải là một đối tượng.')
  const data = { ...body }
  for (const [key, label, max, optional] of [['company', 'Tên doanh nghiệp', 150], ['category', 'Ngành nghề', 100], ['address', 'Địa chỉ', 500], ['representativeName', 'Người đại diện', 120], ['representativeTitle', 'Chức danh', 80], ['website', 'Website', 500, true]]) data[key] = adminText(body[key], label, max, { optional })
  return applicationFields(data, value => value)
}
