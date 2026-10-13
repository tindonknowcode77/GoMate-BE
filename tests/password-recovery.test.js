import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { hashPassword, verifyPassword } from '../src/modules/auth/password.js'
import { hashToken, newToken } from '../src/modules/auth/token.js'

test('password recovery, change, single use, attempts and session revocation', async t => {
  const mongo = await MongoMemoryServer.create(); t.after(() => mongo.stop())
  const client = createClient(readConfig({ MONGODB_URI: mongo.getUri('password_recovery') }))
  await client.connect(); t.after(() => client.close())
  const db = client.db(); await initializeDatabase(db)
  const repo = createAuthRepository(db), email = 'reset@example.com', password = 'OriginalPassword123!'
  const user = await repo.createUser({ email, name: 'Reset User', passwordHash: await hashPassword(password) })
  await db.collection('users').updateOne({ id: user.id }, { $set: { email_verified: true } })
  let code, sent = 0, failMail = false
  const mailer = { assertConfigured() {}, async sendResetCode(_email, value) { if (failMail) throw new Error('SMTP failed'); code = value; sent++ } }
  const server = createApp(readConfig({}), { authRepository: repo, verificationMailer: mailer }).listen(0, '127.0.0.1')
  await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)))
  const req = async (path, body, token) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/${path}`, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, body: await response.json() }
  }
  const login = async pass => req('login', { email, password: pass })
  const token = (await login(password)).body.accessToken
  const secondToken = (await login(password)).body.accessToken
  const generic = await req('forgot-password', { email: 'unknown@example.com' })
  const forgot = await req('forgot-password', { email })
  assert.deepEqual(forgot, generic); assert.equal(forgot.status, 200); assert.equal(sent, 1)
  await req('forgot-password', { email }); assert.equal(sent, 1)
  assert.match(code, /^\d{6}$/)
  const stored = await repo.findUserByEmail(email)
  assert.notEqual(stored.password_reset.hash, code)
  assert.equal(await verifyPassword(code, stored.password_reset.hash), true)
  assert.equal((await req('reset-password', { email, code, newPassword: 'short' })).status, 400)
  const nextPassword = 'NewPassword123456!'
  const results = await Promise.all([1, 2].map(() => req('reset-password', { email, code, newPassword: nextPassword })))
  assert.deepEqual(results.map(r => r.status).sort(), [200, 400])
  assert.equal((await req('me', undefined, token)).status, 401)
  assert.equal((await req('me', undefined, secondToken)).status, 401)
  assert.equal((await login(password)).status, 401)
  const newTokenValue = (await login(nextPassword)).body.accessToken
  assert.equal((await req('me', undefined, newTokenValue)).status, 200)
  // Even a delayed session creation using credentials observed before reset is revoked.
  const staleToken = newToken()
  await repo.createSession({ userId: user.id, tokenHash: hashToken(staleToken), expiresAt: new Date(Date.now() + 60000), credentialVersion: 0 })
  assert.equal(await repo.findSession(hashToken(staleToken)), null)
  assert.equal((await req('change-password', { currentPassword: nextPassword, newPassword: password })).status, 401)
  assert.equal((await req('change-password', { currentPassword: 'wrong', newPassword: password }, newTokenValue)).status, 400)
  assert.equal((await req('change-password', { currentPassword: nextPassword, newPassword: nextPassword }, newTokenValue)).status, 400)
  assert.equal((await req('change-password', { currentPassword: nextPassword, newPassword: password }, newTokenValue)).status, 200)
  assert.equal((await req('me', undefined, newTokenValue)).status, 401)
  assert.equal((await login(password)).status, 200)
  const hash = await hashPassword('123456')
  await repo.reservePasswordReset(email, hash)
  for (let i = 0; i < 5; i++) assert.equal(await repo.resetPassword(email, '999999', 'unused'), false)
  assert.equal(await repo.resetPassword(email, '123456', 'unused'), false)
  await db.collection('users').updateOne({ id: user.id }, { $set: { 'password_reset.sent_at': new Date(0) } })
  await repo.reservePasswordReset(email, hash)
  await db.collection('users').updateOne({ id: user.id }, { $set: { 'password_reset.expires_at': new Date(0) } })
  assert.equal(await repo.resetPassword(email, '123456', 'unused'), false)
  await db.collection('users').updateOne({ id: user.id }, { $unset: { password_reset: '' } })
  failMail = true
  assert.deepEqual(await req('forgot-password', { email }), generic)
  assert.equal((await repo.findUserByEmail(email)).password_reset, undefined)
  const google = await repo.findOrCreateGoogleUser({ email: 'google@example.com', googleSub: '123', name: 'Google' })
  assert.equal(await repo.reservePasswordReset(google.email, hash), null)
  assert.equal(await repo.changePassword(google.id, password, hash, 0), false)
})
