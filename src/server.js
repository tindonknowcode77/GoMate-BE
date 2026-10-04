import { createApp } from './app.js'
import { readConfig } from './config/env.js'
import { createClient, initializeDatabase } from './database/mongo.js'
import { createAuthRepository } from './modules/auth/repository.js'
import { createActivityRepository } from './modules/activities/repository.js'

const config = readConfig()
let client
try {
  client = createClient(config)
  await client.connect()
  await initializeDatabase(client.db())
} catch {
  console.error('MongoDB connection or initialization failed. Check MONGODB_URI in GoMate-BE/.env and database access.')
  await client?.close()
  process.exit(1)
}
const authRepository = createAuthRepository(client.db())
const activityRepository = createActivityRepository(client.db())
const server = createApp(config, { authRepository, activityRepository }).listen(config.port, config.host, () => {
  console.log(`GoMate (FE + API) running at http://${config.host}:${config.port}`)
})

server.on('error', async (error) => {
  console.error('Failed to start GoMate API:', error.message)
  process.exitCode = 1
  await client.close()
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(async () => {
      await client.close()
      process.exit(0)
    })
    setTimeout(() => process.exit(1), 10000).unref()
  })
}
