import { randomUUID } from 'node:crypto'
import { HttpError } from './http-error.js'

const PLAN_FILE_TYPES = [
  { ext: /\.xlsx$/i, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', check: b => b.subarray(0, 4).toString('hex') === '504b0304' },
  { ext: /\.xls$/i, mime: 'application/vnd.ms-excel', check: b => b.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1' },
  { ext: /\.docx$/i, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', check: b => b.subarray(0, 4).toString('hex') === '504b0304' },
  { ext: /\.doc$/i, mime: 'application/msword', check: b => b.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1' },
  { ext: /\.pdf$/i, mime: 'application/pdf', check: b => b.subarray(0, 4).toString('ascii') === '%PDF' },
  { ext: /\.png$/i, mime: 'image/png', check: b => b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' },
  { ext: /\.(jpe?g)$/i, mime: 'image/jpeg', check: b => b.subarray(0, 3).toString('hex') === 'ffd8ff' },
  { ext: /\.webp$/i, mime: 'image/webp', check: b => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
]

export const planKeys = ['itinerary', 'planLink', 'planAttachment']
export function planningFields(body, activity) {
  const fields = {}
  if (body.planLink !== undefined) {
    if (typeof body.planLink !== 'string' || body.planLink.length > 2000) throw new HttpError(400, 'Invalid planLink')
    const link = body.planLink.trim()
    if (link) { try { const url = new URL(link); if (url.protocol !== 'https:' || url.username || url.password) throw new Error() } catch { throw new HttpError(400, 'Dùng đường dẫn HTTPS hợp lệ cho kế hoạch') } }
    fields.planLink = link
  }
  if (body.itinerary !== undefined) {
    if (!Array.isArray(body.itinerary) || body.itinerary.length > 60) throw new HttpError(400, 'Tối đa 60 mốc lịch trình')
    fields.itinerary = body.itinerary.map((step, index) => {
      if (!step || typeof step !== 'object' || Array.isArray(step) || Object.keys(step).some(key => !['id', 'date', 'time', 'title', 'place', 'note'].includes(key))) throw new HttpError(400, 'Invalid itinerary step')
      const result = { id: typeof step.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(step.id) ? step.id : randomUUID() }
      for (const [key, limit] of [['date', 10], ['time', 5], ['title', 120], ['place', 200], ['note', 500]]) {
        const value = step[key] ?? ''
        if (typeof value !== 'string' || value.length > limit) throw new HttpError(400, `Invalid itinerary ${key}`)
        result[key] = value.trim()
      }
      if (!result.title || !/^\d{4}-\d{2}-\d{2}$/.test(result.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(result.time)) throw new HttpError(400, `Bổ sung ngày, giờ và nội dung mốc ${index + 1}`)
      const date = new Date(`${result.date}T${result.time}:00+07:00`)
      if (!Number.isFinite(date.getTime()) || new Date(date.getTime() + 7 * 3600000).toISOString().slice(0, 10) !== result.date || date < activity.startsAt || date > activity.endsAt) throw new HttpError(400, 'Mốc lịch trình cần nằm trong thời gian hoạt động')
      return result
    })
    if (new Set(fields.itinerary.map(item => item.id)).size !== fields.itinerary.length) throw new HttpError(400, 'Duplicate itinerary IDs')
    fields.itinerary.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time))
    fields.plan = fields.itinerary.map(step => `${step.date} ${step.time} · ${step.title}`).slice(0, 20)
  }
  if (body.planAttachment !== undefined) {
    if (body.planAttachment === null) { fields.planFile = null; fields.planFileData = null }
    else {
      const file = body.planAttachment
      const matched = typeof file?.name === 'string' ? PLAN_FILE_TYPES.find(item => item.ext.test(file.name)) : null
      if (!file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).some(key => !['name', 'base64'].includes(key)) || typeof file.name !== 'string' || file.name.length > 120 || !matched || /[\/\\\r\n]/.test(file.name) || typeof file.base64 !== 'string' || file.base64.length > 14000000 || file.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(file.base64)) {
        throw new HttpError(400, 'Chọn tệp PDF, Word, Excel hoặc ảnh (.png/.jpg/.webp), tối đa 10 MB')
      }
      const buffer = Buffer.from(file.base64, 'base64')
      if (!buffer.length || buffer.length > 10 * 1024 * 1024 || !matched.check(buffer)) {
        throw new HttpError(400, 'Tệp đính kèm không hợp lệ hoặc không đúng định dạng')
      }
      fields.planFile = { id: randomUUID(), name: file.name.trim(), size: buffer.length, mimeType: matched.mime }
      fields.planFileData = buffer
    }
  }
  return fields
}
