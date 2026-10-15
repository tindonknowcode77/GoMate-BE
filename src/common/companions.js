import { HttpError } from './http-error.js'

export function companionFields(value, count) {
  if (!Array.isArray(value) || value.length > count || value.some(item => !item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['name', 'note'].includes(key)) || typeof item.name !== 'string' || item.name.trim().length > 80 || typeof item.note !== 'string' || item.note.trim().length > 200)) throw new HttpError(400, 'Invalid companion information')
  return Array.from({ length: count }, (_, index) => ({ name: value[index]?.name.trim() ?? '', note: value[index]?.note.trim() ?? '' }))
}
