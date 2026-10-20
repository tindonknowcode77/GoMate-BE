import { readConfig } from '../config/env.js'
import { createClient, initializeDatabase } from './mongo.js'
import { hashPassword } from '../modules/auth/password.js'
import { createAuthRepository } from '../modules/auth/repository.js'

const email = (process.argv[2] || 'admin@gomate.app').trim().toLowerCase()
const password = process.argv[3] || 'Admin123!'
const name = process.argv[4] || 'GoMate Admin'

const client = createClient(readConfig())
try {
  await client.connect()
  const db = client.db()
  await initializeDatabase(db)
  const auth = createAuthRepository(db)
  const passwordHash = await hashPassword(password)
  let user = await db.collection('users').findOne({ email })
  if (!user) {
    user = await auth.createUser({ name, email, passwordHash })
  }
  await db.collection('users').updateOne(
    { id: user.id },
    {
      $set: {
        name,
        password_hash: passwordHash,
        role: 'admin',
        email_verified: true,
        updated_at: new Date(),
      },
      $inc: { credential_version: 1 },
    }
  )
  console.log(JSON.stringify({ email, password, role: 'admin', status: 'ready' }, null, 2))
} finally {
  await client.close()
}

