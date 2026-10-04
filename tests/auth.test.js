import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { hashToken, newToken } from '../src/modules/auth/token.js'
import { hashPassword, verifyPassword } from '../src/modules/auth/password.js'
import { createClient, initializeDatabase } from '../src/database/mongo.js'

async function serve(app) {
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    async request(path, { method = 'GET', body, token, origin } = {}) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(origin ? { Origin: origin } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: response.status, headers: response.headers,
        body: response.status === 204 ? null : await response.json() }
    },
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

test('authentication lifecycle using the MongoDB engine', async t => {
  const mongo = await MongoMemoryServer.create()
  t.after(() => mongo.stop())
  const connection = createClient(readConfig({ MONGODB_URI: mongo.getUri('gomate_test') }))
  await connection.connect()
  t.after(() => connection.close())
  const db = connection.db()
  await initializeDatabase(db)
  await initializeDatabase(db)
  const repository = createAuthRepository(db)
  const config = readConfig({})
  const delivered = []
  let mailFails = false
  const verificationMailer = { assertConfigured() {}, async sendCode(email, code) {
    if (mailFails) throw new Error('SMTP unavailable')
    delivered.push({ email, code })
  } }
  const client = await serve(createApp(config, { authRepository: repository, verificationMailer }))
  t.after(async () => { await client.close() })
  const account = { name: 'Test User', email: '  TEST@example.com ', password: 'a long test password' }
  let userId, token, otherToken

  await t.test('rejects invalid input without creating a user', async () => {
    const response = await client.request('/register', { method: 'POST', body: { ...account, password: 'short' } })
    assert.equal(response.status, 400)
    assert.equal(await db.collection('users').countDocuments(), 0)
  })
  await t.test('registers normalized email and stores only a salted password hash', async () => {
    const response = await client.request('/register', { method: 'POST', body: { ...account, role: 'admin' } })
    assert.equal(response.status, 201)
    assert.equal(response.body.user.email, 'test@example.com')
    assert.deepEqual(Object.keys(response.body.user).sort(), ['createdAt', 'email', 'id', 'name'])
    userId = response.body.user.id
    const saved = await repository.findUserByEmail('test@example.com')
    assert.notEqual(saved.password_hash, account.password)
    assert.ok(await verifyPassword(account.password, saved.password_hash))
    assert.equal(response.headers.get('cache-control'), 'no-store')
  })
  await t.test('unique email constraint handles simultaneous duplicate registrations', async () => {
    const responses = await Promise.all([1, 2].map(() => client.request('/register', { method: 'POST', body: account })))
    assert.deepEqual(responses.map(response => response.status), [409, 409])
    assert.equal(await db.collection('users').countDocuments(), 1)
  })
  await t.test('email verification gates login and codes are single use', async () => {
    assert.equal((await client.request('/login', { method: 'POST', body: account })).status, 403)
    assert.equal(delivered.length, 1)
    const { code } = delivered[0]
    assert.match(code, /^\d{6}$/)
    const saved = await repository.findUserByEmail('test@example.com')
    assert.notEqual(saved.verification.hash, code)
    await client.request('/resend-verification', { method: 'POST', body: account })
    assert.equal(delivered.length, 1)
    const wrong = code === '000000' ? '111111' : '000000'
    assert.equal((await client.request('/verify-email', { method: 'POST', body: { email: account.email, code: wrong } })).status, 400)
    assert.equal((await client.request('/verify-email', { method: 'POST', body: { email: account.email, code } })).status, 200)
    assert.equal((await client.request('/verify-email', { method: 'POST', body: { email: account.email, code } })).status, 400)
    assert.equal((await repository.findUserByEmail('test@example.com')).verification, undefined)
  })
  await t.test('expired and exhausted codes fail; resend replaces codes and mail failure is recoverable', async () => {
    const email = 'pending@example.com'
    const pending = await repository.createUser({ email, name: 'Pending', passwordHash: 'unused' })
    const oldHash = await hashPassword('123456')
    await repository.reserveVerification(email, oldHash)
    for (let i = 0; i < 5; i++) assert.equal(await repository.verifyEmail(email, '000000'), false)
    assert.equal(await repository.verifyEmail(email, '123456'), false)
    await db.collection('users').updateOne({ id: pending.id }, { $set: { 'verification.sent_at': new Date(0) } })
    await client.request('/resend-verification', { method: 'POST', body: { email } })
    const freshCode = delivered.at(-1).code
    assert.equal(await repository.verifyEmail(email, '123456'), false)
    await db.collection('users').updateOne({ id: pending.id }, { $set: {
      'verification.expires_at': new Date(0), 'verification.sent_at': new Date(0),
    } })
    assert.equal(await repository.verifyEmail(email, freshCode), false)
    mailFails = true
    assert.equal((await client.request('/resend-verification', { method: 'POST', body: { email } })).status, 500)
    assert.equal((await repository.findUserByEmail(email)).verification, undefined)
    mailFails = false
    await client.request('/resend-verification', { method: 'POST', body: { email } })
    const results = await Promise.all([1, 2].map(() => repository.verifyEmail(email, delivered.at(-1).code)))
    assert.deepEqual(results.sort(), [false, true])
    await db.collection('users').deleteOne({ id: pending.id })
  })
  await t.test('wrong password and unknown account return the same error', async () => {
    const wrong = await client.request('/login', { method: 'POST', body: { ...account, password: 'incorrect password' } })
    const missing = await client.request('/login', { method: 'POST', body: { ...account, email: 'missing@example.com' } })
    assert.equal(wrong.status, 401)
    assert.equal(missing.status, 401)
    assert.deepEqual(wrong.body, missing.body)
    assert.equal(await db.collection('auth_sessions').countDocuments(), 0)
  })
  await t.test('login issues independent sessions with only token hashes stored', async () => {
    const response = await client.request('/login', { method: 'POST', body: account })
    assert.equal(response.status, 200)
    token = response.body.accessToken
    assert.equal(response.body.tokenType, 'Bearer')
    assert.equal(response.body.expiresIn, 86400)
    assert.equal(response.body.user.id, userId)
    const sessions = await db.collection('auth_sessions').find().toArray()
    assert.equal(sessions[0].token_hash, hashToken(token))
    assert.equal(response.body.expiresAt, sessions[0].expires_at.toISOString())
    assert.notEqual(sessions[0].token_hash, token)
    const second = await client.request('/login', { method: 'POST', body: account })
    otherToken = second.body.accessToken
    assert.notEqual(token, otherToken)
  })
  await t.test('protected route rejects absent, forged and expired tokens', async () => {
    for (const invalid of [undefined, 'malformed', newToken()]) {
      assert.equal((await client.request('/me', { token: invalid })).status, 401)
    }
    const expired = newToken()
    await repository.createSession({ tokenHash: hashToken(expired), userId, expiresAt: new Date(Date.now() - 60000) })
    assert.equal((await client.request('/me', { token: expired })).status, 401)
    const response = await client.request('/me', { token })
    assert.equal(response.status, 200)
    assert.equal(response.body.user.id, userId)
    assert.ok(response.body.expiresIn > 0 && response.body.expiresIn <= 86400)
    assert.equal(response.body.expiresAt, (await db.collection('auth_sessions').findOne({ token_hash: hashToken(token) })).expires_at.toISOString())
  })
  await t.test('remembered sessions restore across app instances without extending expiry and revoke on logout', async () => {
    const response = await client.request('/login', { method: 'POST', body: { ...account, rememberMe: true } })
    assert.equal(response.status, 200)
    assert.equal(response.body.expiresIn, 30 * 24 * 60 * 60)
    const saved = await db.collection('auth_sessions').findOne({ token_hash: hashToken(response.body.accessToken) })
    assert.equal(saved.expires_at.toISOString(), response.body.expiresAt)
    assert.equal(saved.accessToken, undefined)
    const second = await serve(createApp(config, { authRepository: createAuthRepository(db) }))
    try {
      const restored = await second.request('/me', { token: response.body.accessToken })
      assert.equal(restored.status, 200)
      assert.equal(restored.body.user.id, userId)
      assert.equal(restored.body.expiresAt, response.body.expiresAt)
      assert.ok(restored.body.expiresIn > 29 * 86400 && restored.body.expiresIn <= response.body.expiresIn)
      assert.equal(restored.body.accessToken, undefined)
      assert.equal(restored.headers.get('cache-control'), 'no-store')
      assert.equal((await second.request('/logout', { method: 'POST', token: response.body.accessToken })).status, 204)
      const revoked = await client.request('/me', { token: response.body.accessToken })
      assert.equal(revoked.status, 401)
      assert.equal(revoked.body.code, 'SESSION_INVALID_OR_EXPIRED')
      assert.equal((await client.request('/me', { token })).status, 200)
    } finally { await second.close() }
  })
  await t.test('rememberMe accepts only booleans and false keeps the normal lifetime', async () => {
    const before = await db.collection('auth_sessions').countDocuments()
    for (const rememberMe of ['true', 1, null, {}]) {
      assert.equal((await client.request('/login', { method: 'POST', body: { ...account, rememberMe } })).status, 400)
    }
    assert.equal(await db.collection('auth_sessions').countDocuments(), before)
    const normal = await client.request('/login', { method: 'POST', body: { ...account, rememberMe: false } })
    assert.equal(normal.status, 200)
    assert.equal(normal.body.expiresIn, 86400)
  })
  await t.test('expired remembered sessions fail even before MongoDB TTL cleanup', async () => {
    const response = await client.request('/login', { method: 'POST', body: { ...account, rememberMe: true } })
    assert.equal(response.status, 200)
    await db.collection('auth_sessions').updateOne({ token_hash: hashToken(response.body.accessToken) }, { $set: { expires_at: new Date(Date.now() - 1000) } })
    const expired = await client.request('/me', { token: response.body.accessToken })
    assert.equal(expired.status, 401)
    assert.equal(expired.body.code, 'SESSION_INVALID_OR_EXPIRED')
    assert.equal(expired.headers.get('www-authenticate'), 'Bearer')
    assert.equal((await client.request('/me')).body.code, 'AUTH_REQUIRED')
  })
  await t.test('sessions survive app recreation and query operators cannot bypass lookup', async () => {
    const second = await serve(createApp(config, { authRepository: createAuthRepository(db) }))
    try {
      assert.equal((await second.request('/me', { token })).status, 200)
      assert.equal(await repository.findUserByEmail({ $ne: null }), null)
    } finally { await second.close() }
  })
  await t.test('logout revokes just the current session', async () => {
    assert.equal((await client.request('/logout', { method: 'POST', token })).status, 204)
    assert.equal((await client.request('/me', { token })).status, 401)
    assert.equal((await client.request('/me', { token: otherToken })).status, 200)
    assert.equal((await client.request('/logout', { method: 'POST' })).status, 401)
  })
  await t.test('deleting a user also invalidates their sessions', async () => {
    await db.collection('users').deleteOne({ id: userId })
    assert.equal((await client.request('/me', { token: otherToken })).status, 401)
    // Orphaned sessions cannot authenticate and are eventually removed by TTL.
  })

  await t.test('Google login creates one identity, issues sessions and never links by email', async () => {
    const googleClient = await serve(createApp(config, {
      authRepository: repository,
      verifyGoogle: async () => ({ googleSub: 'google-123', email: 'google@example.com', name: 'Google User' }),
    }))
    try {
      assert.equal((await googleClient.request('/google', { method: 'POST', body: {} })).status, 400)
      assert.equal((await googleClient.request('/google', { method: 'POST', body: { idToken: 'test', rememberMe: 'true' } })).status, 400)
      const remembered = await googleClient.request('/google', { method: 'POST', body: { idToken: 'test', rememberMe: true } })
      assert.equal(remembered.status, 200)
      assert.equal(remembered.body.expiresIn, 30 * 86400)
      const results = await Promise.all([1, 2].map(() => googleClient.request('/google', {
        method: 'POST', body: { idToken: 'verified-by-test-double', email: 'attacker@example.com' },
      })))
      for (const response of results) {
        assert.equal(response.status, 200)
        assert.equal(response.body.user.email, 'google@example.com')
        assert.equal((await googleClient.request('/me', { token: response.body.accessToken })).status, 200)
      }
      assert.equal(results[0].body.user.id, results[1].body.user.id)
      assert.equal(await db.collection('users').countDocuments({ google_sub: 'google-123' }), 1)
      const token = results[0].body.accessToken
      assert.equal((await googleClient.request('/logout', { method: 'POST', token })).status, 204)
      assert.equal((await googleClient.request('/me', { token })).status, 401)
      assert.equal((await googleClient.request('/login', { method: 'POST', body: {
        email: 'google@example.com', password: 'arbitrary password',
      } })).status, 401)
      const collision = await serve(createApp(config, { authRepository: repository,
        verifyGoogle: async () => ({ googleSub: 'other-google-id', email: 'google@example.com', name: 'Other' }),
      }))
      try {
        assert.equal((await collision.request('/google', { method: 'POST', body: { idToken: 'token' } })).status, 409)
      } finally { await collision.close() }
      await repository.createUser({ email: 'password@example.com', name: 'Password', passwordHash: 'test-hash' })
      await assert.rejects(repository.findOrCreateGoogleUser({ googleSub: 'new-id', email: 'password@example.com', name: 'Other' }), { code: 11000 })
      assert.equal((await repository.findUserByEmail('password@example.com')).google_sub, undefined)
      assert.equal((await client.request('/google', { method: 'POST', body: { idToken: 'token' } })).status, 503)
    } finally { await googleClient.close() }
  })
})

test('auth rate limits and browser CORS', async t => {
  const client = await serve(createApp(readConfig({}), { authRepository: {} }))
  t.after(() => client.close())
  for (let i = 0; i < 5; i++) {
    assert.equal((await client.request('/register', { method: 'POST', body: {} })).status, 400)
  }
  const limited = await client.request('/register', { method: 'POST', body: {} })
  assert.equal(limited.status, 429)
  assert.ok(limited.headers.get('retry-after'))
  for (let i = 0; i < 20; i++) {
    assert.equal((await client.request('/login', { method: 'POST', body: {} })).status, 400)
  }
  assert.equal((await client.request('/login', { method: 'POST', body: {} })).status, 429)
  const preflight = await client.request('/login', { method: 'OPTIONS', origin: 'http://localhost:5173' })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173')
})

test('password salts differ and configuration fails safely', async () => {
  const a = await hashPassword('a sufficiently long password')
  const b = await hashPassword('a sufficiently long password')
  assert.notEqual(a, b)
  assert.equal(await verifyPassword('wrong password', a), false)
  assert.throws(() => createClient(readConfig({})), /MONGODB_URI/)
  for (const value of ['0', '-1', '721', 'not-a-number']) {
    assert.throws(() => readConfig({ SESSION_TTL_HOURS: value }), /SESSION_TTL_HOURS/)
  }
  assert.throws(() => readConfig({ TRUST_PROXY_HOPS: 'true' }), /TRUST_PROXY_HOPS/)
  for (const value of ['0', '-1', '721', 'not-a-number', '23', '24.5']) {
    assert.throws(() => readConfig({ REMEMBER_SESSION_TTL_HOURS: value }), /REMEMBER_SESSION_TTL_HOURS/)
  }
  assert.equal(readConfig({ REMEMBER_SESSION_TTL_HOURS: '168' }).rememberSessionTtlHours, 168)
  assert.equal(readConfig({}).rememberSessionTtlHours, 720)
})
