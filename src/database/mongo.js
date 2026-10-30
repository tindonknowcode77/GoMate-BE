import { MongoClient } from 'mongodb'
import { setServers } from 'node:dns'

export function createClient(config) {
  if (!config.mongodbUri) throw new Error('MONGODB_URI is required. Set it in GoMate-BE/.env.')
  if (config.mongodbDnsServers?.length) setServers(config.mongodbDnsServers)
  return new MongoClient(config.mongodbUri, { maxPoolSize: 5, serverSelectionTimeoutMS: 10000 })
}

export async function initializeDatabase(db) {
  await db.collection('business_audiences').createIndex({ userId: 1, postId: 1 }, { unique: true })
  await db.collection('activities').createIndex({ businessPostId: 1, id: 1 })
  await db.collection('business_applications').createIndex({ ownerId: 1 }, { unique: true })
  await db.collection('business_applications').createIndex({ country: 1, certificateNumber: 1 }, { unique: true, partialFilterExpression: { certificateNumber: { $type: 'string' }, status: { $in: ['pending', 'approved'] } } })
  await db.collection('business_verification_files').createIndex({ id: 1 }, { unique: true })
  await db.collection('business_applications').createIndex({ taxId: 1 }, { unique: true, partialFilterExpression: { schemaVersion: 2, taxId: { $type: 'string' }, status: { $in: ['pending', 'approved'] } } })
  for (const name of ['business_locations', 'business_staff']) { await db.collection(name).createIndex({ id: 1 }, { unique: true }); await db.collection(name).createIndex({ ownerId: 1, createdAt: -1 }) }
  await db.collection('business_staff').createIndex({ ownerId: 1, userId: 1 }, { unique: true })
  await db.collection('business_staff').createIndex({ userId: 1, status: 1 })
  for (const name of ['business_applications', 'business_posts', 'support_tickets']) {
    await db.collection(name).createIndex({ id: 1 }, { unique: true })
    await db.collection(name).createIndex({ ownerId: 1, createdAt: -1 })
    await db.collection(name).createIndex({ status: 1, createdAt: -1 })
  }
  await db.collection('activity_drafts').createIndex({ ownerId: 1 }, { unique: true })
  await db.collection('chat_attachments').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
  await db.collection('chat_attachments').createIndex({ conversationId: 1, ownerId: 1 })
  await db.collection('notifications').createIndex({ userId: 1, key: 1 }, { unique: true })
  await db.collection('notifications').createIndex({ userId: 1, createdAt: -1, id: -1 })
  await db.collection('user_blocks').createIndex({ ownerId: 1, targetId: 1 }, { unique: true })
  await db.collection('user_blocks').createIndex({ targetId: 1 })
  await db.collection('reports').createIndex({ key: 1 }, { unique: true })
  await db.collection('rating_submissions').createIndex({ activityId: 1, userId: 1 }, { unique: true })
  await db.collection('activity_ratings').createIndex({ activityId: 1, authorId: 1, targetUserId: 1 }, { unique: true, partialFilterExpression: { authorId: { $type: 'string' } } })
  await db.collection('activity_ratings').createIndex({ targetUserId: 1, createdAt: -1 })
  await db.collection('friendships').createIndex({ key: 1 }, { unique: true })
  await db.collection('friendships').createIndex({ id: 1 }, { unique: true })
  await db.collection('friendships').createIndex({ participantIds: 1, status: 1, updatedAt: -1 })
  await db.collection('conversations').createIndex({ id: 1 }, { unique: true })
  await db.collection('conversations').createIndex({ key: 1 }, { unique: true })
  await db.collection('conversations').createIndex({ participantIds: 1, createdAt: -1 })
  await db.collection('conversations').createIndex({ activityId: 1 })
  await db.collection('chat_messages').createIndex({ conversationId: 1, _id: -1 })
  await db.collection('chat_messages').createIndex({ conversationId: 1, senderId: 1, clientMessageId: 1 }, { unique: true })
  await db.collection('chat_reads').createIndex({ conversationId: 1, userId: 1 }, { unique: true })
  await db.collection('activities').createIndex({ id: 1 }, { unique: true })
  await db.collection('activities').createIndex({ coordinates: '2dsphere' })
  await db.collection('activities').createIndex({ status: 1, startsAt: 1, id: 1 })
  await db.collection('activities').createIndex({ hostId: 1, createdAt: -1, id: 1 })
  await db.collection('activities').createIndex({ 'joinRequests.userId': 1, 'joinRequests.status': 1 })
  await db.collection('users').createIndex({ email: 1 }, { unique: true })
  await db.collection('users').createIndex({ id: 1 }, { unique: true })
  await db.collection('users').createIndex({ username: 1 }, {
    unique: true, partialFilterExpression: { username: { $type: 'string' } },
  })
  await db.collection('users').createIndex({ google_sub: 1 }, {
    unique: true, partialFilterExpression: { google_sub: { $type: 'string' } },
  })
  await db.collection('auth_sessions').createIndex({ token_hash: 1 }, { unique: true })
  await db.collection('auth_sessions').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 })
  await db.collection('auth_sessions').createIndex({ user_id: 1 })
}
