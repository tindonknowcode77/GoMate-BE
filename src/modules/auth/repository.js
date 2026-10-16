import { createPortalRepository } from '../portal/repository.js'
import { createDraftRepository } from '../drafts/repository.js'
import { randomUUID } from 'node:crypto'
import { verifyPassword } from './password.js'
import { createCommunityRepository } from '../community/repository.js'
import { HttpError } from '../../common/http-error.js'

export function createAuthRepository(db) {
  const users = db.collection('users')
  const sessions = db.collection('auth_sessions')
  const community = createCommunityRepository(db)
  return {
    community,
    portal: createPortalRepository(db),
    drafts: createDraftRepository(db),
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
    async createSession({ tokenHash, userId, expiresAt, credentialVersion }) {
      const version = credentialVersion ?? (await users.findOne({ id: userId }))?.credential_version ?? 0
      await sessions.insertOne({ token_hash: tokenHash, user_id: userId, expires_at: expiresAt, credential_version: version })
    },
    async findSessionUser(tokenHash) {
      const result = await this.findSession(tokenHash)
      return result?.user ?? null
    },
    async findSession(tokenHash) {
      // TTL cleanup is asynchronous; enforce expiration on every request.
      const session = await sessions.findOne({ token_hash: { $eq: tokenHash }, expires_at: { $gt: new Date() } })
      if (!session) return null
      const user = await users.findOne({ id: session.user_id, $or: [{ email_verified: true }, { google_sub: { $type: 'string' } }] }, { projection: { password_hash: 0, verification: 0, password_reset: 0, avatar: 0 } })
      return user && (user.credential_version ?? 0) === (session.credential_version ?? 0) ? { user, expiresAt: session.expires_at } : null
    },
    async reservePasswordReset(email, hash) {
      const now = new Date()
      return users.findOneAndUpdate({ email, email_verified: true, password_hash: { $type: 'string' },
        $or: [{ 'password_reset.sent_at': { $exists: false } }, { 'password_reset.sent_at': { $lte: new Date(now - 60000) } }],
      }, { $set: { password_reset: { hash, sent_at: now, expires_at: new Date(+now + 600000), attempts: 0 } } }, { returnDocument: 'after' })
    },
    async cancelPasswordReset(id, hash) {
      await users.updateOne({ id, 'password_reset.hash': hash }, { $unset: { password_reset: '' } })
    },
    async resetPassword(email, code, passwordHash) {
      const user = await users.findOneAndUpdate({ email, email_verified: true,
        'password_reset.expires_at': { $gt: new Date() }, 'password_reset.attempts': { $lt: 5 },
      }, { $inc: { 'password_reset.attempts': 1 } }, { returnDocument: 'after' })
      if (!user || !await verifyPassword(code, user.password_reset.hash)) return false
      const result = await users.updateOne({ id: user.id, password_hash: user.password_hash,
        'password_reset.hash': user.password_reset.hash, 'password_reset.expires_at': { $gt: new Date() },
      }, { $set: { password_hash: passwordHash, updated_at: new Date() },
        $inc: { credential_version: 1 }, $unset: { password_reset: '' } })
      return result.modifiedCount === 1
    },
    async changePassword(id, currentPassword, passwordHash, credentialVersion) {
      const user = await users.findOne({ id })
      if (!user?.password_hash || (user.credential_version ?? 0) !== credentialVersion || !await verifyPassword(currentPassword, user.password_hash)) return false
      const result = await users.updateOne({ id, password_hash: user.password_hash,
        credential_version: user.credential_version ?? { $exists: false },
      }, { $set: { password_hash: passwordHash, updated_at: new Date() },
        $inc: { credential_version: 1 }, $unset: { password_reset: '' } })
      return result.modifiedCount === 1
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
      return users.findOne({ id }, { projection: { password_hash: 0, verification: 0, password_reset: 0, avatar: 0 } })
    },
    async updateProfile(id, fields) {
      const { username, ...rest } = fields
      return users.findOneAndUpdate({ id }, {
        $set: { ...rest, ...(username ? { username } : {}), updated_at: new Date() },
        ...(username === '' ? { $unset: { username: '' } } : {}),
      }, { returnDocument: 'after', projection: { password_hash: 0, verification: 0, password_reset: 0, avatar: 0 } })
    },
    async replaceProfilePhotos(id, previous, photos) {
      return users.findOneAndUpdate({ id, profile_photo_version: previous.profile_photo_version ?? { $exists: false } },
        { $set: { profile_photos: photos, updated_at: new Date() }, $inc: { profile_photo_version: 1 } }, { returnDocument: 'after' })
    },
    async profileReviews(userId) {
      const match = { targetUserId: userId, score: { $gte: 1, $lte: 5 } }
      const [items, summary] = await Promise.all([
        db.collection('activity_ratings').find(match, { projection: { _id: 0, id: 1, score: 1, comment: 1, activityTitle: 1, createdAt: 1 } }).sort({ createdAt: -1 }).limit(50).toArray(),
        db.collection('activity_ratings').aggregate([{ $match: match }, { $group: { _id: null, average: { $avg: '$score' }, count: { $sum: 1 } } }]).toArray(),
      ])
      return { items, average: summary[0]?.average ?? null, count: summary[0]?.count ?? 0 }
    },
    async searchPeople(userId, q) {
      const excluded = await community.blockedIds(userId)
      const literal = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const people = await users.find({ id: { $nin: [userId, ...excluded] }, 'settings.discoverable': { $ne: false }, $or: [{ name: { $regex: literal, $options: 'i' } }, { username: { $regex: literal.replace(/^@/, ''), $options: 'i' } }] }, { projection: { _id: 0, id: 1, name: 1, username: 1, location: 1, avatar_url: 1 } }).sort({ name: 1, id: 1 }).limit(20).toArray()
      const relations = await db.collection('friendships').find({ participantIds: userId, $or: [{ requesterId: { $in: people.map(item => item.id) } }, { recipientId: { $in: people.map(item => item.id) } }] }).toArray()
      return people.map(person => { const relation = relations.find(item => item.participantIds.includes(person.id)); return { id: person.id, name: person.name, username: person.username ?? '', location: person.location ?? '', avatarUrl: person.avatar_url ?? null, friendshipId: relation?.id, friendshipStatus: relation?.status, incoming: relation?.recipientId === userId } })
    },
    async friendship(userId, targetId) {
      const row = await db.collection('friendships').findOne({ key: JSON.stringify([userId, targetId].sort()) })
      return row ? { id: row.id, status: row.status, incoming: row.recipientId === userId } : { status: 'none' }
    },
    async friendRequest(userId, targetId) {
      if (await community.blocked(userId, targetId) || !(await community.settings(targetId)).allowFriendRequests) throw new HttpError(403, 'Tài khoản này không nhận lời mời kết bạn')
      const participantIds = [userId, targetId].sort(), key = JSON.stringify(participantIds), now = new Date()
      const fresh = { id: randomUUID(), key, participantIds, requesterId: userId, recipientId: targetId, status: 'pending', createdAt: now, updatedAt: now }
      let row
      try { row = await db.collection('friendships').findOneAndUpdate({ key }, { $setOnInsert: fresh }, { upsert: true, returnDocument: 'after' }) }
      catch (error) { if (error.code !== 11000) throw error; row = await db.collection('friendships').findOne({ key }) }
      if (row.status === 'declined') row = await db.collection('friendships').findOneAndUpdate({ key, status: 'declined' }, { $set: { requesterId: userId, recipientId: targetId, status: 'pending', updatedAt: now } }, { returnDocument: 'after' }) ?? await db.collection('friendships').findOne({ key })
      if (row.status === 'pending' && row.requesterId === userId) await community.notify(targetId, { key: `friend:${row.id}:${row.updatedAt.toISOString()}`, type: 'friend-request', title: 'Lời mời kết bạn', text: 'Bạn có lời mời kết bạn mới.', actorId: userId })
      return { id: row.id, status: row.status, incoming: row.recipientId === userId }
    },
    async decideFriend(userId, requestId, status) {
      const row = await db.collection('friendships').findOneAndUpdate({ id: requestId, recipientId: userId, status: 'pending' }, { $set: { status, updatedAt: new Date() } }, { returnDocument: 'after' })
      if (row && status === 'accepted') await community.notify(row.requesterId, { key: `friend-accepted:${row.id}`, type: 'friend-accepted', title: 'Đã kết bạn', text: 'Lời mời kết bạn của bạn đã được chấp nhận.', actorId: userId })
      return row
    },
    async listFriends(userId, page, limit, pending = false) {
      const query = { participantIds: userId, status: pending ? 'pending' : 'accepted' }
      const [rows, total] = await Promise.all([db.collection('friendships').find(query).sort({ updatedAt: -1, id: 1 }).skip((page - 1) * limit).limit(limit).toArray(), db.collection('friendships').countDocuments(query)])
      const people = await users.find({ id: { $in: rows.map(row => row.participantIds.find(id => id !== userId)) } }, { projection: { _id: 0, id: 1, name: 1, username: 1, location: 1, avatar_url: 1 } }).toArray()
      return { items: rows.flatMap(row => { const user = people.find(person => row.participantIds.includes(person.id)); return user ? [{ id: user.id, name: user.name, username: user.username ?? '', location: user.location ?? '', avatarUrl: user.avatar_url ?? null, friendshipId: row.id, friendshipStatus: row.status, incoming: row.recipientId === userId }] : [] }), total, page, limit, hasMore: page * limit < total }
    },
    async removeFriend(userId, targetId) { await db.collection('friendships').deleteOne({ key: JSON.stringify([userId, targetId].sort()) }) },
    async resolveFriends(userId, ids) {
      if (!ids.length) return []
      const relations = await db.collection('friendships').find({ key: { $in: ids.map(id => JSON.stringify([userId, id].sort())) }, status: 'accepted' }).toArray()
      if (relations.length !== ids.length) return null
      const people = await users.find({ id: { $in: ids } }, { projection: { _id: 0, password_hash: 0, verification: 0, password_reset: 0, avatar: 0 } }).toArray()
      return people.length === ids.length ? people : null
    },
    async saveCover(id, previous, image) {
      return users.findOneAndUpdate({ id, cover_version: previous.cover_version ?? { $exists: false } },
        { $set: { cover_url: image?.url ?? null, cover_public_id: image?.publicId ?? null, updated_at: new Date() }, $inc: { cover_version: 1 } }, { returnDocument: 'after' })
    },
    async saveMatchFilters(id, filters) {
      await users.updateOne({ id }, { $set: { match_filters: filters } })
    },
    async setFavorite(id, activityId, saved) {
      return users.updateOne({ id, ...(saved ? { $or: [{ favorite_activity_ids: activityId }, { $expr: { $lt: [{ $size: { $ifNull: ['$favorite_activity_ids', []] } }, 500] } }] } : {}) },
        saved ? { $addToSet: { favorite_activity_ids: activityId } } : { $pull: { favorite_activity_ids: activityId } })
    },
    async recordMatchSignal(id, category, weight) {
      await users.updateOne({ id }, [{ $set: { [`match_signals.${category}`]: { $max: [-10, { $min: [10, { $add: [{ $ifNull: [`$match_signals.${category}`, 0] }, weight] }] }] } } }])
    },
    async saveAvatar(id, image) {
      return users.findOneAndUpdate({ id }, {
        $set: { avatar_url: image.url, avatar_public_id: image.publicId, updated_at: new Date() },
        $unset: { avatar: '', avatar_version: '' },
      }, { returnDocument: 'before', projection: { password_hash: 0, verification: 0, password_reset: 0, avatar: 0 } })
    },
    async getAvatar(id) {
      const user = await users.findOne({ id }, { projection: { avatar: 1 } })
      return user?.avatar ? Buffer.from(user.avatar.buffer) : null
    },
  }
}
