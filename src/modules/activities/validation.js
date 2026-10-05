import { HttpError } from '../../common/http-error.js'

export const activityCategories = ['Ăn uống', 'Thể thao', 'Du lịch', 'Giải trí', 'Học tập', 'Gaming', 'Khác']
export function activityFields(body, previous) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid activity body')
  const fields = {}
  const text = { title: [3, 120], description: [1, 3000], location: [2, 200] }
  const allowed = [...Object.keys(text), 'category', 'startsAt', 'endsAt', 'estimatedCost', 'maxParticipants', 'tags', 'requirements', 'plan', 'coordinates', 'coverBase64']
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.includes(key)) throw new HttpError(400, `Unsupported activity field: ${key}`)
    if (key === 'coverBase64') {
      if (typeof value !== 'string' || !value.length) throw new HttpError(400, 'Invalid cover image')
      continue
    }
    if (Object.hasOwn(text, key)) {
      if (typeof value !== 'string' || value.trim().length < text[key][0] || value.trim().length > text[key][1]) throw new HttpError(400, `Invalid ${key}`)
      fields[key] = value.trim()
    } else if (key === 'category') {
      if (!activityCategories.includes(value)) throw new HttpError(400, 'Invalid category')
      fields[key] = value
    } else if (key === 'startsAt' || key === 'endsAt') {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) throw new HttpError(400, `${key} must be an ISO UTC date`)
      const date = new Date(value)
      if (!Number.isFinite(date.getTime()) || date.toISOString().replace('.000Z', 'Z') !== value.replace('.000Z', 'Z')) throw new HttpError(400, `Invalid ${key}`)
      fields[key] = date
    } else if (key === 'estimatedCost' || key === 'maxParticipants') {
      const min = key === 'maxParticipants' ? 2 : 0
      const max = key === 'maxParticipants' ? 1000 : 1000000000
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
  const merged = { ...previous, ...fields }
  for (const key of ['title', 'description', 'location', 'category', 'startsAt', 'endsAt', 'estimatedCost', 'maxParticipants']) {
    if (merged[key] === undefined) throw new HttpError(400, `Missing ${key}`)
  }
  if (merged.startsAt <= new Date() || merged.endsAt <= merged.startsAt) throw new HttpError(400, 'Activity must start in the future and end after it starts')
  if (merged.maxParticipants < (previous?.memberCount ?? 1)) throw new HttpError(409, 'Capacity cannot be below the current member count')
  return fields
}

export function publicActivity(row) {
  const keys = ['id', 'hostId', 'hostName', 'title', 'description', 'category', 'location', 'coordinates', 'startsAt', 'endsAt', 'estimatedCost', 'maxParticipants', 'memberCount', 'tags', 'requirements', 'plan', 'imageUrl', 'status', 'createdAt', 'updatedAt', 'version']
  return Object.fromEntries(keys.filter(key => row[key] !== undefined).map(key => [key, row[key]]))
}
