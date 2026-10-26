import { createApp } from './app.js'
import { readConfig } from './config/env.js'
import { createClient, initializeDatabase } from './database/mongo.js'
import { databaseStartupError } from './database/startup-error.js'
import { createAuthRepository } from './modules/auth/repository.js'
import { createActivityRepository } from './modules/activities/repository.js'
import { createChatRepository } from './modules/chat/repository.js'
import { createActivityScheduler } from './modules/activities/scheduler.js'

const config = readConfig()
let client
let databasePhase = 'connection'
try {
  client = createClient(config)
  await client.connect()
  databasePhase = 'initialization'
  await initializeDatabase(client.db())
} catch (error) {
  console.error(databaseStartupError(error, databasePhase))
  await client?.close()
  process.exit(1)
}
const authRepository = createAuthRepository(client.db())
const activityRepository = createActivityRepository(client.db())
const chatRepository = createChatRepository(client.db())
const scheduler = createActivityScheduler(client.db(), authRepository.community)
const reconcileActivities = () => scheduler.tick().catch(error => console.error('Activity schedule check failed:', error.message))
await reconcileActivities()
const scheduleTimer = setInterval(reconcileActivities, 30000)
scheduleTimer.unref()
const server = createApp(config, { authRepository, activityRepository, chatRepository }).listen(config.port, config.host, () => {
  console.log(`GoMate (FE + API) running at http://${config.host}:${config.port}`)
})

server.on('error', async (error) => {
  console.error('Failed to start GoMate API:', error.message)
  clearInterval(scheduleTimer)
  process.exitCode = 1
  await client.close()
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    clearInterval(scheduleTimer)
    server.close(async () => {
      await client.close()
      process.exit(0)
    })
    setTimeout(() => process.exit(1), 10000).unref()
  })
}
