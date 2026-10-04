import { MongoClient } from 'mongodb'

export function createClient(config) {
  if (!config.mongodbUri) throw new Error('MONGODB_URI is required. Set it in GoMate-BE/.env.')
  return new MongoClient(config.mongodbUri, { maxPoolSize: 5, serverSelectionTimeoutMS: 10000 })
}

export async function initializeDatabase(db) {
  await db.collection('activities').createIndex({ id: 1 }, { unique: true })
  await db.collection('activities').createIndex({ coordinates: '2dsphere' })
  await db.collection('activities').createIndex({ status: 1, startsAt: 1, id: 1 })
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
