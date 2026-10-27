import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { readConfig } from '../src/config/env.js'
import { createCommunityRepository } from '../src/modules/community/repository.js'
import { createActivityScheduler } from '../src/modules/activities/scheduler.js'

test('scheduled completion and reminders are durable, idempotent and member-scoped', async t => {
  const mongo = await MongoMemoryServer.create(); t.after(() => mongo.stop())
  const client = createClient(readConfig({ MONGODB_URI: mongo.getUri('scheduler') }))
  await client.connect(); t.after(() => client.close())
  const db = client.db(); await initializeDatabase(db)
  const now = new Date('2026-10-26T05:00:00Z'), activities = db.collection('activities')
  const base = { hostId: 'host', title: 'Meetup', version: 1, startsAt: new Date(+now - 7200000), endsAt: new Date(+now - 1000), joinRequests: [{ userId: 'member', status: 'approved' }, { userId: 'pending', status: 'pending' }], updates: [] }
  await activities.insertMany([
    { ...base, id: 'overdue', status: 'published' },
    { ...base, id: 'running', status: 'in-progress', attendance: [{ userId: 'member', status: 'unmarked' }] },
    { ...base, id: 'cancelled', status: 'cancelled' },
    { ...base, id: 'upcoming', status: 'published', startsAt: new Date(+now + 1800000), endsAt: new Date(+now + 7200000) },
    { ...base, id: 'later', status: 'published', startsAt: new Date(+now + 1800001), endsAt: new Date(+now + 7200000) },
  ])
  const community = createCommunityRepository(db)
  const first = createActivityScheduler(db, community), second = createActivityScheduler(db, community)
  await Promise.all([first.tick(now), second.tick(now)])
  await first.tick(now)
  for (const id of ['overdue', 'running']) {
    const row = await activities.findOne({ id })
    assert.equal(row.status, id === 'overdue' ? 'expired' : 'completed'); assert.equal(row.version, 2); assert.equal(row.updates.length, 1)
    assert.equal(+(row.completedAt || row.expiredAt), +base.endsAt)
    assert.equal(await db.collection('notifications').countDocuments({ activityId: id }), 2)
  }
  assert.deepEqual((await activities.findOne({ id: 'running' })).attendance, [{ userId: 'member', status: 'unmarked' }])
  assert.equal((await activities.findOne({ id: 'cancelled' })).status, 'cancelled')
  assert.equal(await db.collection('notifications').countDocuments({ activityId: 'upcoming' }), 2)
  assert.equal(await db.collection('notifications').countDocuments({ activityId: 'later' }), 0)
  assert.equal(await db.collection('notifications').countDocuments({ userId: 'pending' }), 0)
  // A changed schedule gets one new reminder instead of reusing the old schedule's key.
  await activities.updateOne({ id: 'upcoming' }, { $set: { startsAt: new Date(+now + 600000) } })
  await second.tick(now)
  assert.equal(await db.collection('notifications').countDocuments({ activityId: 'upcoming' }), 4)
  await activities.insertOne({ ...base, id: 'retry', status: 'published' })
  const failing = createActivityScheduler(db, { notifyScheduled: async () => { throw new Error('Temporary notification failure') } })
  await assert.rejects(failing.tick(now), /Temporary notification failure/)
  assert.equal((await activities.findOne({ id: 'retry' })).status, 'expired')
  assert.notEqual((await activities.findOne({ id: 'retry' })).autoCompletionNotified, true)
  await createActivityScheduler(db, community).tick(now)
  assert.equal(await db.collection('notifications').countDocuments({ activityId: 'retry' }), 2)
  assert.equal((await activities.findOne({ id: 'retry' })).autoCompletionNotified, true)
  await db.collection('users').insertOne({ id: 'host', settings: { notifyActivity: false } })
  await activities.updateOne({ id: 'upcoming' }, { $set: { startsAt: new Date(+now + 300000) } })
  await first.tick(now)
  assert.equal(await db.collection('notifications').countDocuments({ activityId: 'upcoming' }), 5)
})
