import { createClient } from './mongo.js'
import { readConfig } from '../config/env.js'

// Operator-only command. Public registration never accepts a privileged role.
const [email, role] = process.argv.slice(2)
if (!email || !['admin', 'staff', 'user'].includes(role)) throw new Error('Usage: npm run portal:role -- email@example.com admin|staff|user')
const client = createClient(readConfig())
try {
  await client.connect()
  const result = await client.db().collection('users').updateOne({ email: email.trim().toLowerCase(), email_verified: true }, { $set: { role, updated_at: new Date() }, $inc: { credential_version: 1 } })
  if (!result.matchedCount) throw new Error('No verified account found. Register and verify email first.')
  console.log('Portal role updated. Existing sessions were invalidated; sign in again.')
} finally { await client.close() }
