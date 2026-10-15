import { HttpError } from './http-error.js'

export const genders = ['male', 'female', 'other', 'undisclosed']
export const religions = ['none', 'buddhist', 'catholic', 'protestant', 'muslim', 'hindu', 'other', 'undisclosed']
export const alcoholValues = ['any', 'yes', 'no']

export function stringList(value, key, allowed) {
  if (!Array.isArray(value) || value.length > 12 || value.some(item => typeof item !== 'string' || !item.trim() || item.trim().length > 40 || (allowed && !allowed.includes(item)))) throw new HttpError(400, `Invalid ${key}`)
  return [...new Set(value.map(item => item.trim()))]
}

export function preferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['genders', 'languages', 'religions', 'alcohol', 'dressCode', 'minAge', 'maxAge'].includes(key))) throw new HttpError(400, 'Invalid participantPreferences')
  const result = { genders: [], languages: [], religions: [], alcohol: 'any', dressCode: '' }
  for (const key of ['genders', 'languages', 'religions']) if (value[key] !== undefined) result[key] = stringList(value[key], key, key === 'genders' ? genders : key === 'religions' ? religions : undefined)
  if (value.alcohol !== undefined) {
    if (!alcoholValues.includes(value.alcohol)) throw new HttpError(400, 'Invalid alcohol preference')
    result.alcohol = value.alcohol
  }
  if (value.dressCode !== undefined) {
    if (typeof value.dressCode !== 'string' || value.dressCode.trim().length > 200) throw new HttpError(400, 'Dress code must be at most 200 characters')
    result.dressCode = value.dressCode.trim()
  }
  for (const key of ['minAge', 'maxAge']) if (value[key] !== undefined) {
    if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 120) throw new HttpError(400, 'Độ tuổi cần từ 0 đến 120')
    result[key] = value[key]
  }
  if (result.minAge && result.maxAge && result.minAge > result.maxAge) throw new HttpError(400, 'Độ tuổi tối thiểu không được lớn hơn tối đa')
  return result
}

export function canParticipate(preferences, user) {
  if (!preferences) return true
  const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10)
  const age = user.birthDate ? Number(today.slice(0, 4)) - Number(user.birthDate.slice(0, 4)) - (today.slice(5) < user.birthDate.slice(5) ? 1 : 0) : null
  return (!(preferences.minAge || preferences.maxAge) || (age !== null && (!preferences.minAge || age >= preferences.minAge) && (!preferences.maxAge || age <= preferences.maxAge))) && (!preferences.genders?.length || preferences.genders.includes(user.gender)) &&
    (!preferences.languages?.length || preferences.languages.some(item => user.languages?.includes(item))) &&
    (!preferences.religions?.length || preferences.religions.includes(user.religion)) &&
    (!preferences.alcohol || preferences.alcohol === 'any' || preferences.alcohol === user.alcohol)
}
