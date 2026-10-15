import { HttpError } from './http-error.js'
import { activityCategories } from '../modules/activities/validation.js'
import { preferences } from './preferences.js'

// Persist only explicit, bounded filter values; GPS is deliberately session-only.
export function matchFilters(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid filters')
  const text = { ward: 100, province: 100, district: 100, dateFrom: 10, dateTo: 10, fromTime: 5, toTime: 5 }
  const lists = { categories: 13, availableDays: 7, timePeriods: 3 }
  const numbers = { distance: 500, minBudget: 1000000000, maxBudget: 1000000000, minimumCapacity: 1000, maximumCapacity: 1000 }
  const result = {}
  for (const [key, value] of Object.entries(body)) {
    if (Object.hasOwn(text, key) && typeof value === 'string' && value.length <= text[key]) result[key] = value
    else if (Object.hasOwn(lists, key) && Array.isArray(value) && value.length <= lists[key] && value.every(item => typeof item === 'string' && item.length <= 40)) result[key] = [...new Set(value)]
    else if (Object.hasOwn(numbers, key) && Number.isFinite(value) && value >= 0 && value <= numbers[key]) result[key] = value
    else if (key === 'organizerType' && ['all', 'personal', 'business'].includes(value)) result[key] = value
    else if (key === 'sort' && ['recommended', 'nearest', 'soonest'].includes(value)) result[key] = value
    else if (key === 'radiusEnabled' && typeof value === 'boolean') result[key] = value
    else if (key === 'preferences') result[key] = preferences(value)
    else throw new HttpError(400, `Invalid filter: ${key}`)
  }
  for (const [key, allowed] of [['categories', activityCategories], ['availableDays', ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN']], ['timePeriods', ['Sáng', 'Chiều', 'Tối']]]) {
    if (result[key]?.some(item => !allowed.includes(item))) throw new HttpError(400, `Invalid filter: ${key}`)
  }
  if (result.distance !== undefined && result.distance < 0.1) throw new HttpError(400, 'Invalid distance')
  for (const key of ['minBudget', 'maxBudget', 'minimumCapacity', 'maximumCapacity']) if (result[key] !== undefined && !Number.isInteger(result[key])) throw new HttpError(400, `Invalid filter: ${key}`)
  for (const key of ['minimumCapacity', 'maximumCapacity']) if (result[key] !== undefined && result[key] !== 0 && result[key] < 2) throw new HttpError(400, `Invalid filter: ${key}`)
  const iso = value => {
    if (!value) return ''
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(value)) throw new HttpError(400, 'Invalid filter date')
    const [day, month, year] = value.split('/'), date = `${year}-${month}-${day}`
    if (!Number.isFinite(new Date(date).getTime()) || new Date(date).toISOString().slice(0, 10) !== date) throw new HttpError(400, 'Invalid filter date')
    return date
  }
  const from = iso(result.dateFrom), to = iso(result.dateTo)
  for (const key of ['fromTime', 'toTime']) if (result[key] && !/^([01]\d|2[0-3]):[0-5]\d$/.test(result[key])) throw new HttpError(400, 'Invalid filter time')
  if ((from && to && from > to) || (result.fromTime && result.toTime && result.fromTime > result.toTime) || result.minBudget > result.maxBudget || (result.maximumCapacity && result.minimumCapacity > result.maximumCapacity)) throw new HttpError(400, 'Invalid filter range')
  return result
}
