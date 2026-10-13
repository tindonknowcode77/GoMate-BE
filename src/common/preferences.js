import { HttpError } from './http-error.js'

export const genders = ['male', 'female', 'other', 'undisclosed']
export const religions = ['none', 'buddhist', 'catholic', 'protestant', 'muslim', 'hindu', 'other', 'undisclosed']
export const alcoholValues = ['any', 'yes', 'no']

export function stringList(value, key, allowed) {
  if (!Array.isArray(value) || value.length > 12 || value.some(item => typeof item !== 'string' || !item.trim() || item.trim().length > 40 || (allowed && !allowed.includes(item)))) throw new HttpError(400, `Invalid ${key}`)
  return [...new Set(value.map(item => item.trim()))]
}

export function preferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['genders', 'languages', 'religions', 'alcohol', 'dressCode'].includes(key))) throw new HttpError(400, 'Invalid participantPreferences')
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
  return result
}

export function canParticipate(preferences, user) {
  if (!preferences) return true
  return (!preferences.genders?.length || preferences.genders.includes(user.gender)) &&
    (!preferences.languages?.length || preferences.languages.some(item => user.languages?.includes(item))) &&
    (!preferences.religions?.length || preferences.religions.includes(user.religion)) &&
    (!preferences.alcohol || preferences.alcohol === 'any' || preferences.alcohol === user.alcohol)
}
