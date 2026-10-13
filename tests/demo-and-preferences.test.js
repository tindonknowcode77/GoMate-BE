import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { readConfig } from '../src/config/env.js'
import { seedDemo } from '../src/database/demo-data.js'
import { createActivityRepository } from '../src/modules/activities/repository.js'
import { searchOptions } from '../src/modules/activities/routes.js'
import { activityFields } from '../src/modules/activities/validation.js'
import { canParticipate, preferences } from '../src/common/preferences.js'
import { credentials } from '../src/modules/auth/validation.js'

test('six-character simple passwords accepted, shorter and oversized passwords rejected', () => {
  assert.equal(credentials({ email: 'demo@example.com', password: '123456', name: 'Demo' }, true).password, '123456')
  for (const password of ['12345', 'x'.repeat(129)]) assert.throws(() => credentials({ email: 'demo@example.com', password, name: 'Demo' }, true), error => error.status === 400)
})

test('participant preferences validate enums and match volunteered profile fields', () => {
  const rule = preferences({ genders: ['other'], languages: ['Tiếng Việt'], religions: ['none'], alcohol: 'no', dressCode: 'Áo trắng' })
  assert.equal(canParticipate(rule, { gender: 'other', languages: ['Tiếng Việt'], religion: 'none', alcohol: 'no' }), true)
  assert.equal(canParticipate(rule, { gender: 'male' }), false)
  assert.equal(canParticipate(preferences({}), {}), true)
  for (const value of [{ genders: ['unknown'] }, { languages: ['a'.repeat(41)] }, { religions: ['unknown'] }, { alcohol: 'unknown' }, { dressCode: 'a'.repeat(201) }, { extra: true }]) assert.throws(() => preferences(value), error => error.status === 400)
  const base = { title: 'Meetup', description: 'A demo', category: 'Ăn uống', location: 'TP.HCM', startsAt: '2099-01-01T02:00:00Z', endsAt: '2099-01-01T04:00:00Z', estimatedCost: 0, maxParticipants: 6 }
  assert.equal(activityFields({ ...base, minParticipants: 3 }).minParticipants, 3)
  for (const minParticipants of [0, 1, 7, 2.5]) assert.throws(() => activityFields({ ...base, minParticipants }), error => error.status === 400)
})

test('demo seeding is idempotent and discovery filters exact Vietnam dates, minutes, capacity and preferences', async t => {
  const mongo = await MongoMemoryServer.create(); t.after(() => mongo.stop())
  const client = createClient(readConfig({ MONGODB_URI: mongo.getUri('demo_data') })); await client.connect(); t.after(() => client.close())
  const db = client.db(); await initializeDatabase(db)
  assert.equal((await seedDemo(db)).created, 20)
  assert.equal((await seedDemo(db)).created, 0)
  assert.equal(await db.collection('activities').countDocuments(), 20)
  assert.equal(await db.collection('users').countDocuments(), 14)
  const people = await db.collection('users').find().toArray()
  for (const person of people) {
    assert.ok(person.bio && person.location && person.birthDate && person.languages.length && person.interests.length)
    assert.match(person.avatar_url, /^https:\/\/randomuser\.me\//)
    assert.match(person.cover_url, /^https:\/\/images\.unsplash\.com\//)
  }
  const activities = await db.collection('activities').find().toArray()
  for (const activity of activities) {
    assert.match(activity.imageUrl, /^https:\/\/images\.unsplash\.com\//)
    assert.equal(activity.memberCount, 1 + activity.joinRequests.filter(request => request.status === 'approved').length)
    assert.ok(activity.memberCount >= activity.minParticipants && activity.memberCount < activity.maxParticipants)
    assert.ok(activity.joinRequests.some(request => request.status === 'pending'))
    assert.equal(new Set(activity.joinRequests.map(request => request.userId)).size, activity.joinRequests.length)
    for (const request of activity.joinRequests) assert.equal(canParticipate(activity.participantPreferences, people.find(person => person.id === request.userId)), true)
  }
  const firstActivity = activities[0]
  await db.collection('activities').updateOne({ id: firstActivity.id }, { $set: { 'joinRequests.0.status': 'left' }, $inc: { memberCount: -1 } })
  await seedDemo(db)
  assert.equal((await db.collection('activities').findOne({ id: firstActivity.id })).joinRequests[0].status, 'left')
  const repository = createActivityRepository(db), userId = '00000000-0000-4000-8000-000000000001'
  assert.equal((await repository.search(searchOptions({}), userId)).total, 20)
  const row = await db.collection('activities').findOne({ title: 'Cà phê làm quen ở Thảo Điền' })
  const day = new Date(row.startsAt.getTime() + 7 * 3600000).toISOString().slice(0, 10)
  const found = await repository.search(searchOptions({ dateFrom: day, dateTo: day, fromTime: '08:59', toTime: '09:00', minParticipants: '2', maxParticipants: '6' }), userId)
  assert.equal(found.total, 1); assert.equal(found.items[0].id, row.id)
  assert.equal(found.items[0].minParticipants, 2)
  assert.equal((await repository.search(searchOptions({ dateFrom: day, dateTo: day, fromTime: '09:01', toTime: '10:00' }), userId)).total, 0)
  const female = await db.collection('activities').findOne({ title: 'Yoga nhẹ nhàng ở công viên Gia Định' })
  assert.equal((await repository.search(searchOptions({ gender: 'male' }), userId)).items.some(item => item.id === female.id), false)
  assert.equal((await repository.search(searchOptions({ gender: 'female' }), userId)).items.some(item => item.id === female.id), true)
  assert.ok((await repository.search(searchOptions({ dressCode: 'yes' }), userId)).items.every(item => item.participantPreferences.dressCode))
  for (const query of [{ dateFrom: '2099-02-30' }, { dateFrom: '2099-01-02', dateTo: '2099-01-01' }, { fromTime: '25:00' }, { fromTime: '10:00', toTime: '09:00' }, { minParticipants: '10', maxParticipants: '3' }, { gender: 'invalid' }]) assert.throws(() => searchOptions(query), error => error.status === 400)
})
