import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'

test('one server serves the SPA, assets and API without masking missing endpoints', async () => {
  const frontendDir = await mkdtemp(join(tmpdir(), 'gomate-fe-'))
  await mkdir(join(frontendDir, 'assets'))
  await writeFile(join(frontendDir, 'index.html'), '<!doctype html><div id="root">GoMate</div>')
  await writeFile(join(frontendDir, 'assets', 'app.js'), 'console.log("GoMate")')
  const server = createApp(readConfig({}), { frontendDir }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    for (const path of ['/', '/trips/123']) {
      const response = await fetch(`${base}${path}`, { headers: { Accept: 'text/html' } })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), /text\/html/)
      assert.match(await response.text(), /GoMate/)
      assert.equal(response.headers.get('cache-control'), 'no-cache')
      assert.ok(!response.headers.get('content-security-policy').includes('upgrade-insecure-requests'))
    }
    const asset = await fetch(`${base}/assets/app.js`)
    assert.equal(asset.status, 200)
    assert.match(asset.headers.get('content-type'), /javascript/)
    assert.equal((await fetch(`${base}/api/health`)).status, 200)
    for (const path of ['/api/missing', '/api', '/assets/missing.js']) {
      const response = await fetch(`${base}${path}`)
      assert.equal(response.status, 404)
      assert.deepEqual(await response.json(), { error: 'Not found' })
    }
    assert.equal((await fetch(`${base}/trips`, { method: 'POST' })).status, 404)
  } finally {
    await new Promise(resolve => server.close(resolve))
    await rm(frontendDir, { recursive: true, force: true })
  }
})

test('HTTP health, CORS, missing routes and malformed JSON', async () => {
  const server = createApp(readConfig({})).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const health = await fetch(`${base}/api/health`, {
      headers: { Origin: 'http://localhost:5173' },
    })
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { status: 'ok', service: 'gomate-be' })
    assert.equal(health.headers.get('access-control-allow-origin'), 'http://localhost:5173')

    const missing = await fetch(`${base}/api/missing`)
    assert.equal(missing.status, 404)
    assert.deepEqual(await missing.json(), { error: 'Not found' })

    const invalid = await fetch(`${base}/api/health`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
    })
    assert.equal(invalid.status, 400)
    assert.deepEqual(await invalid.json(), { error: 'Invalid request' })
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('configuration rejects invalid ports', () => {
  for (const port of ['abc', '', '0', '-1', '65536', '3.5']) {
    assert.throws(() => readConfig({ PORT: port }), /PORT/)
  }
  assert.equal(readConfig({ PORT: '4000' }).port, 4000)
  assert.equal(readConfig({}).port, 3000)
})

test('CORS allows configured Expo origins and supports comma-separated origins', async t => {
  const config = readConfig({ CORS_ORIGIN: 'http://localhost:8081, http://127.0.0.1:8081, http://localhost:8082, http://127.0.0.1:8082' })
  const server = createApp(config).listen(0, '127.0.0.1')
  await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api/health`
  for (const origin of config.corsOrigin) {
    const response = await fetch(base, { headers: { Origin: origin } })
    assert.equal(response.headers.get('access-control-allow-origin'), origin)
  }
  const blocked = await fetch(base, { headers: { Origin: 'https://untrusted.example' } })
  assert.equal(blocked.headers.get('access-control-allow-origin'), null)
  const preflight = await fetch(base, { method: 'OPTIONS', headers: { Origin: 'http://localhost:8082', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,authorization' } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:8082')
  assert.ok(readConfig({}).corsOrigin.includes('http://localhost:8082'))
})

test('production binds publicly and respects the platform port', () => {
  const config = readConfig({ NODE_ENV: 'production', PORT: '10000' })
  assert.equal(config.host, '0.0.0.0')
  assert.equal(config.port, 10000)
  assert.equal(readConfig({}).host, '127.0.0.1')
  assert.equal(readConfig({ NODE_ENV: 'production', HOST: '127.0.0.1' }).host, '127.0.0.1')
})
