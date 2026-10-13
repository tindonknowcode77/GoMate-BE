import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { hashToken } from '../src/modules/auth/token.js'

test('personal activity routes enforce identity, query validation and no-store', async t => {
  const token = 'a'.repeat(43)
  const calls = []
  const authRepository = { async findSession(hash) {
    return hash === hashToken(token) ? { user: { id: 'member-1', name: 'Member' }, expiresAt: new Date(Date.now() + 60000) } : null
  } }
  const activityRepository = { async participating(...args) {
    calls.push(args)
    return { items: [], total: 0, page: args[1].page, limit: args[1].limit, hasMore: false }
  } }
  const server = createApp(readConfig({}), { authRepository, activityRepository }).listen(0, '127.0.0.1')
  await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)))
  const get = (path, bearer = token) => fetch(`http://127.0.0.1:${server.address().port}/api/me/${path}`, {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  })
  for (const path of ['activities', 'join-requests']) {
    assert.equal((await get(path, '')).status, 401)
    assert.equal((await get(path, 'b'.repeat(43))).status, 401)
    for (const query of ['userId=someone', 'page=0', 'limit=51', 'page=1&page=2']) {
      assert.equal((await get(`${path}?${query}`)).status, 400)
    }
  }
  assert.equal((await get('activities?status=pending')).status, 400)
  assert.equal((await get('join-requests?status=bad')).status, 400)
  assert.equal(calls.length, 0)
  const response = await get('activities')
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { items: [], total: 0, page: 1, limit: 20, hasMore: false })
  assert.deepEqual(calls.pop(), ['member-1', { page: 1, limit: 20, status: undefined }, false])
  for (const status of ['pending', 'approved', 'rejected', 'cancelled']) {
    assert.equal((await get(`join-requests?status=${status}&page=2&limit=10`)).status, 200)
    assert.deepEqual(calls.pop(), ['member-1', { page: 2, limit: 10, status }, true])
  }
  assert.equal((await get('join-requests')).status, 200)
  assert.deepEqual(calls.pop(), ['member-1', { page: 1, limit: 20, status: undefined }, true])
})
