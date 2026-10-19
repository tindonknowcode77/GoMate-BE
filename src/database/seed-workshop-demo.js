import { readConfig } from '../config/env.js'
import { createClient, initializeDatabase } from './mongo.js'
import { seedWorkshopDemo } from './workshop-demo.js'

if (process.env.NODE_ENV === 'production') throw Error('Workshop demo seeding is disabled in production')
const client = createClient(readConfig())
try {
  await client.connect(); await initializeDatabase(client.db())
  const result = await seedWorkshopDemo(client.db(), { password: process.env.WORKSHOP_DEMO_PASSWORD || 'DemoGoMate123!' })
  console.log(JSON.stringify(result, null, 2))
  console.log('Open /demo on the frontend. Existing demo accounts and activity memberships are preserved.')
} catch (error) { console.error('Workshop demo failed:', error.message); process.exitCode = 1 }
finally { await client.close() }
