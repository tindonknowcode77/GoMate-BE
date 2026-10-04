import { randomUUID } from 'node:crypto'
import { verifyPassword } from './password.js'

export function createAuthRepository(db) {
  const users = db.collection('users')
  const sessions = db.collection('auth_sessions')
  return {
    async createUser({ email, name, passwordHash }) {
      const user = { id: randomUUID(), email, name, password_hash: passwordHash, email_verified: false, created_at: new Date() }
      await users.insertOne(user)
      return user
    },
    async findUserByEmail(email) {
      return users.findOne({ email: { $eq: email } }, { projection: { avatar: 0 } })
    },
    async findOrCreateGoogleUser({ googleSub, email, name }) {
      const existing = await users.findOne({ google_sub: googleSub })
      if (existing) return existing
      const user = { id: randomUUID(), google_sub: googleSub, email, name, email_verified: true, created_at: new Date() }
      try {
        await users.insertOne(user)
        return user
      } catch (error) {
        // Concurrent first logins may create the same Google identity.
        if (error.code === 11000) {
          const concurrent = await users.findOne({ google_sub: googleSub })
          if (concurrent) return concurrent
        }
        // Never link an existing password account solely by matching email.
        throw error
      }
    },
    async createSession({ tokenHash, userId, expiresAt }) {
      await sessions.insertOne({ token_hash: tokenHash, user_id: userId, expires_at: expiresAt })
    },
    async findSessionUser(tokenHash) {
      const result = await this.findSession(tokenHash)
      return result?.user ?? null
    },
    async findSession(tokenHash) {
      // TTL cleanup is asynchronous; enforce expiration on every request.
      const session = await sessions.findOne({ token_hash: { $eq: tokenHash }, expires_at: { $gt: new Date() } })
      if (!session) return null
      const user = await users.findOne({ id: session.user_id, $or: [{ email_verified: true }, { google_sub: { $type: 'string' } }] }, { projection: { password_hash: 0, verification: 0, avatar: 0 } })
      return user ? { user, expiresAt: session.expires_at } : null
    },
    async reserveVerification(email, codeHash) {
      const now = new Date()
      return users.findOneAndUpdate({ email, email_verified: { $ne: true }, google_sub: { $exists: false },
        $or: [{ 'verification.sent_at': { $exists: false } }, { 'verification.sent_at': { $lte: new Date(now - 60000) } }],
      }, { $set: { verification: { hash: codeHash, sent_at: now, expires_at: new Date(+now + 600000), attempts: 0 } } }, { returnDocument: 'after' })
    },
    async cancelVerification(id, codeHash) {
      await users.updateOne({ id, 'verification.hash': codeHash }, { $unset: { verification: '' } })
    },
    async verifyEmail(email, code) {
      const user = await users.findOneAndUpdate({ email, email_verified: { $ne: true },
        'verification.expires_at': { $gt: new Date() }, 'verification.attempts': { $lt: 5 },
      }, { $inc: { 'verification.attempts': 1 } }, { returnDocument: 'after' })
      if (!user || !await verifyPassword(code, user.verification.hash)) return false
      const result = await users.updateOne({ id: user.id, email_verified: { $ne: true },
        'verification.hash': user.verification.hash, 'verification.expires_at': { $gt: new Date() },
      }, { $set: { email_verified: true, email_verified_at: new Date() }, $unset: { verification: '' } })
      return result.modifiedCount === 1
    },
    async deleteSession(tokenHash) {
      await sessions.deleteOne({ token_hash: { $eq: tokenHash } })
    },
    async getProfile(id) {
      return users.findOne({ id }, { projection: { password_hash: 0, verification: 0, avatar: 0 } })
    },
    async updateProfile(id, fields) {
      const { username, ...rest } = fields
      return users.findOneAndUpdate({ id }, {
        $set: { ...rest, ...(username ? { username } : {}), updated_at: new Date() },
        ...(username === '' ? { $unset: { username: '' } } : {}),
      }, { returnDocument: 'after', projection: { password_hash: 0, verification: 0, avatar: 0 } })
    },
    async saveAvatar(id, image) {
      return users.findOneAndUpdate({ id }, {
        $set: { avatar_url: image.url, avatar_public_id: image.publicId, updated_at: new Date() },
        $unset: { avatar: '', avatar_version: '' },
      }, { returnDocument: 'before', projection: { password_hash: 0, verification: 0, avatar: 0 } })
    },
    async getAvatar(id) {
      const user = await users.findOne({ id }, { projection: { avatar: 1 } })
      return user?.avatar ? Buffer.from(user.avatar.buffer) : null
    },
  }
}
