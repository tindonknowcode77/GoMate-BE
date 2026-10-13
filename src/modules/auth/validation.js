import { HttpError } from '../../common/http-error.js'

export function credentials(body, registration = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'JSON object required')
  }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, 'Valid email required')
  }
  const password = body.password
  if (typeof password !== 'string' || password.length < (registration ? 6 : 1) || password.length > 128) {
    throw new HttpError(400, registration ? 'Mật khẩu cần từ 6 đến 128 ký tự' : 'Invalid password')
  }
  if (!registration) return { email, password }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (name.length < 2 || name.length > 100) {
    throw new HttpError(400, 'Name must contain 2 to 100 characters')
  }
  return { email, password, name }
}
