import assert from 'node:assert/strict'
import { test } from 'node:test'
import { databaseStartupError } from '../src/database/startup-error.js'
import { readConfig } from '../src/config/env.js'

test('DNS override is opt-in and accepts only a bounded list of IP addresses', () => {
  assert.deepEqual(readConfig({}).mongodbDnsServers, [])
  assert.deepEqual(readConfig({ MONGODB_DNS_SERVERS: '8.8.8.8, 8.8.4.4' }).mongodbDnsServers, ['8.8.8.8', '8.8.4.4'])
  assert.throws(() => readConfig({ MONGODB_DNS_SERVERS: 'https://example.com' }), /MONGODB_DNS_SERVERS/)
  assert.throws(() => readConfig({ MONGODB_DNS_SERVERS: '1.1.1.1,8.8.8.8,8.8.4.4,9.9.9.9' }), /MONGODB_DNS_SERVERS/)
})

test('startup diagnostics distinguish DNS, authentication and index failures without leaking driver details', () => {
  const secret = 'mongodb+srv://private:password@private-host/db'
  const cases = [
    [{ code: 'ECONNREFUSED', syscall: 'querySrv' }, 'connection', /DNS lookup failed/],
    [{ code: 'ETIMEOUT', syscall: 'queryTxt' }, 'connection', /database has not been contacted/],
    [{ code: 18 }, 'connection', /authentication failed/],
    [{ code: 13 }, 'initialization', /access denied/],
    [{ code: 11000 }, 'initialization', /duplicate/],
    [{ code: 85 }, 'initialization', /incompatible existing index/],
    [{ name: 'MongoParseError' }, 'connection', /not a valid/],
    [{}, 'initialization', /connected, but database initialization failed/],
    [{}, 'connection', /connection failed/],
  ]
  for (const [error, phase, expected] of cases) {
    const result = databaseStartupError({ ...error, message: secret, stack: secret }, phase)
    assert.match(result, expected)
    assert.equal(result.includes(secret), false)
  }
})
