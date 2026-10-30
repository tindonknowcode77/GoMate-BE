import { createHash, randomBytes } from 'node:crypto'

export const newToken = () => randomBytes(32).toString('base64url')
export const hashToken = token => createHash('sha256').update(token).digest('hex')

export function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name, createdAt: user.created_at, emailVerified: user.email_verified === true || Boolean(user.google_sub) }
}
