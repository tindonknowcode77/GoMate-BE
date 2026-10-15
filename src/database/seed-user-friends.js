import { randomUUID } from 'node:crypto'
import { readConfig } from '../config/env.js'
import { createClient, initializeDatabase } from './mongo.js'
import { hashPassword } from '../modules/auth/password.js'
import { demoMembers } from './demo-media.js'

export async function seedUserFriends(db, email, password) {
  const owner = await db.collection('users').findOne({ email: email.toLowerCase() })
  if (!owner) throw new Error('Target account was not found; no users were created')
  const passwordHash = await hashPassword(password), now = new Date(), accounts = []
  for (let i = 0; i < 5; i++) {
    const template = demoMembers[i], friendEmail = `pminh.friend${i + 1}@gomate.local`
    const existing = await db.collection('users').findOne({ email: friendEmail })
    if (existing && existing.demo_seed !== 'pminh-friends') throw new Error('A requested demo email belongs to another account')
    const id = existing?.id || randomUUID()
    await db.collection('users').updateOne({ email: friendEmail }, { $setOnInsert: { ...template, id, email: friendEmail, username: `pminh_friend_${i + 1}`, password_hash: passwordHash, email_verified: true, demo_seed: 'pminh-friends', created_at: now }, $set: { updated_at: now } }, { upsert: true })
    const key = JSON.stringify([owner.id, id].sort())
    await db.collection('friendships').updateOne({ key }, { $setOnInsert: { id: randomUUID(), key, requesterId: owner.id, recipientId: id, participantIds: [owner.id, id], createdAt: now }, $set: { status: 'accepted', updatedAt: now } }, { upsert: true })
    accounts.push({ email: friendEmail, name: template.name, avatar: Boolean(template.avatar_url) })
  }
  return { owner: owner.email, accounts }
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/seed-user-friends.js')) {
  const client = createClient(readConfig())
  try { await client.connect(); await initializeDatabase(client.db()); console.log(JSON.stringify(await seedUserFriends(client.db(), process.env.DEMO_FRIEND_OWNER || 'pminh2004@gmail.com', process.env.DEMO_PASSWORD || 'gomate123'))) }
  catch (error) { console.error('Friend seeding failed:', error.message); process.exitCode = 1 }
  finally { await client.close() }
}
