import { readConfig } from '../config/env.js'
import { createClient, initializeDatabase } from './mongo.js'
import { seedDemo } from './demo-data.js'

const client = createClient(readConfig())
try {
  await client.connect(); await initializeDatabase(client.db())
  const result = await seedDemo(client.db(), { password: process.env.DEMO_PASSWORD || 'gomate123' })
  console.log(`Demo ready: ${result.created} new activities; ${result.total} demo templates. Existing rows preserved.`)
  console.log(`${result.users} demo users with remote photos and seeded approved/pending membership.`)
  console.log(`Accounts: ${result.accounts.join(', ')}`)
} catch (error) { console.error('Demo seeding failed:', error.message); process.exitCode = 1 }
finally { await client.close() }
