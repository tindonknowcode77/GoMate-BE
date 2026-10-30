import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { createActivityRepository } from '../src/modules/activities/repository.js'
import { createChatRepository } from '../src/modules/chat/repository.js'
import { newToken, hashToken } from '../src/modules/auth/token.js'

test('business registration, revisions, multi-group publication, staff consent and real group operations', async t => {
  const mongo = await MongoMemoryServer.create(); t.after(() => mongo.stop())
  const client = createClient(readConfig({ MONGODB_URI: mongo.getUri('business_workflow') })); await client.connect(); t.after(() => client.close())
  const db = client.db(); await initializeDatabase(db)
  const auth = createAuthRepository(db), activities = createActivityRepository(db), chat = createChatRepository(db), users = [], tokens = []
  for (const [index, role] of ['user', 'user', 'user', 'staff', 'admin', 'user', 'user'].entries()) {
    const user = await auth.createUser({ name: 'Business account ' + index, email: `business-flow${index}@example.com`, passwordHash: 'unused' }); users.push(user); tokens.push(newToken())
    await db.collection('users').updateOne({ id: user.id }, { $set: { role, email_verified: true, birthDate: '2000-01-01', gender: 'other', languages: ['Tiếng Việt'] } })
    await auth.createSession({ userId: user.id, tokenHash: hashToken(tokens[index]), expiresAt: new Date(Date.now() + 600000) })
  }
  const server = createApp(readConfig({}), { authRepository: auth, activityRepository: activities, chatRepository: chat }).listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const call = async (user, path, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { Authorization: 'Bearer ' + tokens[user], 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, body: response.status === 204 ? null : response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text() }
  }
  const expect = (response, status = 200) => { assert.equal(response.status, status, JSON.stringify(response.body)); return response.body }
  const profile = { company: 'Business full profile', category: 'Workshop', taxId: '0312345678', address: '12 Nguyễn Huệ, TP. Hồ Chí Minh', representativeName: 'Nguyễn Văn An', representativeTitle: 'Giám đốc', representativeEmail: 'AN@example.com', representativePhone: '+84 901 234 567', website: 'https://example.com', document: { name: 'license.pdf', mime: 'application/pdf', base64: Buffer.from('%PDF-1.4\nPrivate license').toString('base64') } }
  let application, location, post, groups, grant, secondGrant
  await t.test('required profile data, unique tax identity, private license and reviewed resubmission persist', async () => {
    expect(await call(0, '/portal/applications', 'POST', { ...profile, representativeEmail: '' }), 400)
    expect(await call(0, '/portal/applications', 'POST', { ...profile, taxId: '123' }), 400)
    application = expect(await call(0, '/portal/applications', 'POST', profile), 201)
    assert.equal(application.representativeEmail, 'an@example.com'); assert.equal(application.representativePhone, '+84901234567')
    assert.equal(application.document, undefined); assert.equal(application.license.name, 'license.pdf')
    expect(await call(1, '/portal/applications', 'POST', profile), 409)
    expect(await call(1, '/portal/applications/' + application.id + '/document'), 404)
    assert.match(expect(await call(0, '/portal/applications/' + application.id + '/document')), /^%PDF/)
    expect(await call(3, '/portal/applications/' + application.id, 'PATCH', { version: 1, status: 'rejected' }), 400)
    application = expect(await call(3, '/portal/applications/' + application.id, 'PATCH', { version: 1, status: 'rejected', reviewNote: 'Bổ sung địa chỉ.' }))
    const { document: _document, ...resubmit } = profile
    application = expect(await call(0, '/portal/applications', 'POST', { ...resubmit, address: '20 Nguyễn Huệ, TP. Hồ Chí Minh', version: application.version }), 201)
    assert.equal(application.reviewedBy, undefined); assert.equal(application.history.length, 3); assert.equal(application.license.name, 'license.pdf')
    expect(await call(3, '/portal/applications/' + application.id, 'PATCH', { version: 1, status: 'approved' }), 409)
    application = expect(await call(3, '/portal/applications/' + application.id, 'PATCH', { version: application.version, status: 'approved' }))
    assert.equal(expect(await call(0, '/portal/me')).role, 'business')
    assert.equal(expect(await call(0, '/portal/me')).application.address, '20 Nguyễn Huệ, TP. Hồ Chí Minh')
    assert.equal(expect(await call(0, '/portal/notifications')).items.length, 2)
    const other = expect(await call(1, '/portal/applications', 'POST', { ...profile, company: 'Other business', taxId: '0312345679' }), 201)
    expect(await call(4, '/portal/applications/' + other.id, 'PATCH', { version: other.version, status: 'approved' }))
  })
  const event = { category: 'Workshop', location: 'TP. Hồ Chí Minh', startsAt: '2099-01-01T02:00:00.000Z', endsAt: '2099-01-01T04:00:00.000Z', estimatedCost: 100000, maxParticipants: 5 }
  let campaign
  await t.test('locations are tenant-owned and one approved campaign creates independently joinable real groups', async () => {
    location = expect(await call(0, '/portal/locations', 'POST', { name: 'Workshop studio', address: '12 Nguyễn Huệ', city: 'TP. Hồ Chí Minh', phone: '0901234567', latitude: 10.77, longitude: 106.69 }), 201)
    expect(await call(1, '/portal/locations/' + location.id, 'PUT', { name: location.name, address: location.address, city: location.city, phone: location.phone, latitude: location.latitude, longitude: location.longitude, version: 1 }), 409)
    assert.equal(expect(await call(1, '/portal/locations')).total, 0)
    campaign = { title: 'Real multi-group campaign', copy: 'Workshop for the community', premium: false, border: 'Solid', discountPercent: 20, offer: 'Welcome drink', offerTerms: 'One per participant', groups: [{ name: 'Morning group', locationId: location.id, depositAmount: 50000, event }, { name: 'Next day group', locationId: location.id, depositAmount: 0, event: { ...event, startsAt: '2099-01-02T02:00:00.000Z', endsAt: '2099-01-02T04:00:00.000Z' } }] }
    expect(await call(1, '/portal/posts', 'POST', campaign), 400)
    post = expect(await call(0, '/portal/posts', 'POST', campaign), 201)
    assert.equal(expect(await call(5, '/activities?q=Real%20multi')).total, 0)
    expect(await call(0, '/portal/locations/' + location.id, 'DELETE', { version: location.version }), 409)
    expect(await call(3, '/portal/posts/' + post.id, 'PATCH', { version: post.version, status: 'rejected' }), 400)
    post = expect(await call(3, '/portal/posts/' + post.id, 'PATCH', { version: post.version, status: 'rejected', reviewNote: 'Clarify offer terms' }))
    post = expect(await call(0, '/portal/posts/' + post.id, 'PUT', { ...campaign, offerTerms: 'One drink per person', version: post.version }))
    expect(await call(0, '/portal/posts/' + post.id, 'PUT', { ...campaign, version: 1 }), 409)
    expect(await call(3, '/portal/posts/' + post.id, 'PATCH', { version: post.version, status: 'approved' }))
    groups = expect(await call(0, '/portal/groups')).items
    assert.equal(groups.length, 2); assert.equal(expect(await call(5, '/activities?q=Real%20multi')).total, 2)
    assert.equal(expect(await call(0, '/activities?q=Real%20multi')).total, 0)
    assert.equal(expect(await call(1, '/portal/groups')).total, 0)
    expect(await call(1, '/portal/groups/' + groups[0].id), 403)
    expect(await call(0, '/portal/posts/' + post.id, 'DELETE', { version: post.version }), 409)
  })
  await t.test('staff consent and admin approval grant only assigned groups; global staff roles are never assigned', async () => {
    const data = { name: 'Group coordinator', email: users[2].email, phone: '0901234567', title: 'Host', groupIds: [groups[0].id] }
    expect(await call(1, '/portal/staff', 'POST', data), 400)
    grant = expect(await call(0, '/portal/staff', 'POST', data), 201)
    expect(await call(4, '/portal/staff-requests/' + grant.id, 'PATCH', { version: 1, status: 'approved' }), 409)
    expect(await call(5, '/portal/staff-invitations/' + grant.id, 'PATCH', { version: 1, status: 'accepted' }), 409)
    assert.equal(expect(await call(2, '/portal/staff-invitations')).items[0].id, grant.id)
    grant = expect(await call(2, '/portal/staff-invitations/' + grant.id, 'PATCH', { version: grant.version, status: 'accepted' }))
    expect(await call(3, '/portal/staff-requests/' + grant.id, 'PATCH', { version: grant.version, status: 'approved' }), 403)
    grant = expect(await call(4, '/portal/staff-requests/' + grant.id, 'PATCH', { version: grant.version, status: 'approved' }))
    assert.equal(expect(await call(2, '/portal/me')).role, 'business-staff')
    assert.equal((await db.collection('users').findOne({ id: users[2].id })).role, 'user')
    assert.equal(expect(await call(2, '/portal/groups')).total, 1)
    const assignedActivities = expect(await call(2, '/me/activities'))
    assert.equal(assignedActivities.total, 1)
    assert.equal(assignedActivities.items[0].id, groups[0].id)
    assert.equal(assignedActivities.items[0].isBusinessManager, true)
    assert.equal(expect(await call(2, '/activities/' + groups[0].id)).activity.isBusinessManager, true)
    assert.equal(expect(await call(2, '/activities/' + groups[0].id + '/members')).total, 1)
    assert.equal(expect(await call(2, '/me/join-requests')).total, 0)
    const automaticChats = expect(await call(2, '/conversations'))
    assert.equal(automaticChats.total, 1)
    assert.equal(automaticChats.items[0].activityId, groups[0].id)
    assert.equal(expect(await call(2, '/conversations')).total, 1)
    expect(await call(2, '/portal/groups/' + groups[1].id), 403)
    expect(await call(2, '/portal/posts', 'POST', campaign), 403)
    const conversation = expect(await call(2, '/conversations', 'POST', { type: 'group', activityId: groups[0].id })).conversation
    assert.equal(conversation.memberCount, 1)
    assert.ok(expect(await call(2, '/conversations')).items.some(item => item.id === conversation.id))
    grant = expect(await call(0, '/portal/staff/' + grant.id, 'PUT', { ...data, title: 'Updated coordinator', version: grant.version }))
    assert.equal(grant.acceptedAt, null)
    expect(await call(2, '/portal/groups'), 403)
    assert.equal(expect(await call(2, '/me/activities')).total, 0)
    assert.equal(expect(await call(2, '/conversations')).total, 0)
    expect(await call(2, '/conversations/' + conversation.id), 403)
    expect(await call(4, '/portal/staff-requests/' + grant.id, 'PATCH', { version: grant.version, status: 'approved' }), 409)
    grant = expect(await call(2, '/portal/staff-invitations/' + grant.id, 'PATCH', { version: grant.version, status: 'accepted' }))
    grant = expect(await call(4, '/portal/staff-requests/' + grant.id, 'PATCH', { version: grant.version, status: 'approved' }))
  })
  await t.test('multiple enterprise staff manage one group independently and admins receive the review queue', async () => {
    secondGrant=expect(await call(0,'/portal/staff','POST',{name:'Second coordinator',email:users[6].email,phone:'0901234567',title:'Assistant',groupIds:[groups[0].id]}),201)
    assert.ok(await db.collection('notifications').findOne({userId:users[4].id,key:'business-staff-queue:'+secondGrant.id+':1'}))
    secondGrant=expect(await call(6,'/portal/staff-invitations/'+secondGrant.id,'PATCH',{version:secondGrant.version,status:'accepted'}))
    secondGrant=expect(await call(4,'/portal/staff-requests/'+secondGrant.id,'PATCH',{version:secondGrant.version,status:'approved'}))
    const group=expect(await call(6,'/portal/groups/'+groups[0].id))
    assert.equal(group.managers.length,2)
    assert.equal(group.memberCount,1)
    expect(await call(6,'/portal/groups/'+groups[1].id),403)
    assert.equal(expect(await call(6,'/portal/me')).role,'business-staff')
  })
  await t.test('assigned staff approve real requests, record audited deposits, plan, notify, attend and finish', async () => {
    const id = groups[0].id, path = '/portal/groups/' + id
    const joined = expect(await call(5, '/activities/' + id + '/join-requests', 'POST', {}), 201).request
    let group = expect(await call(2, path))
    group = expect(await call(2, path + '/requests/' + joined.id, 'PATCH', { version: group.version, status: 'approved' }))
    assert.equal(group.depositMembers.length, 1); assert.equal(group.readiness.ready, false)
    expect(await call(0, '/activities/' + id + '/start', 'POST', {}), 409)
    expect(await call(2, path + '/deposits/' + users[1].id, 'PATCH', { version: group.version, status: 'paid' }), 400)
    group = expect(await call(2, path + '/deposits/' + users[5].id, 'PATCH', { version: group.version, status: 'paid' }))
    const receipt = (await activities.get(id)).businessReceipts[0]
    assert.equal(receipt.recordedBy, users[2].id); assert.equal(receipt.method, 'manual'); assert.equal(receipt.amount, 50000)
    assert.equal(await db.collection('notifications').countDocuments({ userId: users[5].id, title: 'Đã xác nhận tiền cọc', activityId: id }), 1)
    assert.equal(expect(await call(2, '/activities/' + id + '/members')).items.find(item => item.userId === users[5].id)?.depositStatus, 'paid')
    expect(await call(2, path + '/plan', 'PUT', { version: group.version, itinerary: [null] }), 400)
    group = expect(await call(2, path + '/plan', 'PUT', { version: group.version, itinerary: [{ id: 'welcome', time: '09:30', title: 'Welcome', locationId: location.id, location: 'Studio', notes: 'Bring a notebook' }] }))
    assert.equal(group.itineraryConfirmed, false)
    assert.equal(group.itinerary[0].locationId,location.id)
    assert.ok(group.itinerary[0].location.includes(location.address))
    assert.deepEqual((await activities.get(id)).coordinates,{type:'Point',coordinates:[location.longitude,location.latitude]})
    const offer = { version: group.version, clientId: 'offer-one', title: 'A real group offer', body: 'Welcome drink', expiresAt: '2099-01-01T02:30:00.000Z' }
    group = expect(await call(2, path + '/offers', 'POST', offer))
    expect(await call(2, path + '/offers', 'POST', offer))
    assert.equal((await db.collection('notifications').countDocuments({ userId: users[5].id, title: offer.title })), 1)
    const currentVersion=group.version
    group=expect(await call(6,path+'/offers/'+group.notifications[0].id,'PUT',{version:currentVersion,title:'Updated drink',body:'Updated offer terms',expiresAt:''}))
    expect(await call(2,path+'/offers/'+group.notifications[0].id,'PUT',{version:currentVersion,title:'Stale update',body:'Ignored',expiresAt:''}),409)
    assert.equal(await db.collection('notifications').countDocuments({userId:users[5].id,title:'Updated drink'}),1)
    // Staff can mark attendance before starting, then confirm schedule, start, update attendance and complete
    group = expect(await call(2, path + '/attendance/' + users[5].id, 'PATCH', { version: group.version, status: 'present' }))
    group = expect(await call(2, path + '/actions/confirm-schedule', 'POST', { version: group.version }))
    group = expect(await call(2, path + '/actions/start', 'POST', { version: group.version }))
    assert.equal(group.attendance.length, 2); assert.equal(group.status, 'in-progress')
    expect(await call(1, path + '/actions/complete', 'POST', { version: group.version }), 403)
    group = expect(await call(2, path + '/actions/complete', 'POST', { version: group.version }))
    assert.equal(group.status, 'completed')
    assert.ok(group.attendance.every(member => member.status === 'present'))
    assert.equal(expect(await call(6, '/activities/' + id)).activity.isBusinessManager, true)
    expect(await call(6, '/activities/' + id + '/members'))
    expect(await call(6, '/activities/' + id + '/attendance'))
    expect(await call(5, '/community/ratings/' + id, 'POST', { score: 5, comment: 'Great event', members: [{ userId: users[0].id, score: 5 }] }))
    expect(await call(0, '/portal/staff/' + grant.id, 'DELETE', { version: grant.version }))
    expect(await call(2, path), 403)
    assert.equal(expect(await call(2, '/me/activities')).total, 0)
    expect(await call(2, '/activities/' + id), 404)
    assert.equal(expect(await call(6,path)).managers.length,1)
    expect(await call(2, '/conversations', 'POST', { type: 'group', activityId: id }), 403)
    assert.equal(expect(await call(2, '/conversations')).total, 0)
  })
  await t.test('failed multi-group publication stays private and stable IDs make retry/recovery safe', async () => {
    const draft = expect(await call(0, '/portal/posts', 'POST', { ...campaign, title: 'Recoverable campaign' }), 201)
    const original = db.collection.bind(db); let calls = 0
    db.collection = name => { const collection = original(name); if (name === 'activities') { const update = collection.updateOne.bind(collection); collection.updateOne = (...args) => { if (++calls === 2) throw new Error('Simulated storage interruption'); return update(...args) } }; return collection }
    try { expect(await call(3, '/portal/posts/' + draft.id, 'PATCH', { version: draft.version, status: 'approved' }), 500) } finally { db.collection = original }
    assert.equal(expect(await call(5, '/activities?q=Recoverable')).total, 0)
    expect(await call(3, '/portal/posts/' + draft.id, 'PATCH', { version: draft.version, status: 'approved' }))
    assert.equal(expect(await call(5, '/activities?q=Recoverable')).total, 2)
    assert.equal(await db.collection('activities').countDocuments({ businessPostId: draft.id }), 2)
    const row = await db.collection('activities').findOne({ businessPostId: draft.id })
    await db.collection('activities').updateOne({ id: row.id }, { $set: { status: 'pending-review' } })
    await auth.portal.reconcilePublications()
    assert.equal((await activities.get(row.id)).status, 'published')
  })
  await t.test('wallet is owner-only, tenant-scoped and manual receipts cannot become spendable', async () => {
    const wallet = expect(await call(0, '/portal/wallet'))
    assert.equal(wallet.mode, 'manual-reconciliation')
    assert.equal(wallet.recordedAmount, 50000)
    assert.equal(wallet.estimatedFee, 5000)
    assert.equal(wallet.estimatedNet, 45000)
    assert.equal(wallet.eligiblePayoutAmount, 45000)
    assert.equal(wallet.groups.find(g => g.id === groups[0].id)?.escrowStatus, 'eligible-after-completion')
    assert.equal(wallet.availableBalance, 0)
    assert.equal(wallet.verifiedHeldBalance, 0)
    assert.equal(expect(await call(1, '/portal/wallet')).recordedAmount, 0)
    expect(await call(2, '/portal/wallet'), 403)
    expect(await call(4, '/portal/wallet'), 403)
    expect(await call(5, '/portal/wallet'), 403)
  })
  await t.test('legacy posts expose version zero and can be reviewed and corrected without migration', async () => {
    const draft = expect(await call(0, '/portal/posts', 'POST', { ...campaign, title: 'Legacy version campaign' }), 201)
    await db.collection('business_posts').updateOne({id:draft.id}, {$unset:{version:''}})
    assert.equal(expect(await call(0, '/portal/posts')).items.find(row=>row.id===draft.id).version, 0)
    let row = expect(await call(3, '/portal/posts/'+draft.id, 'PATCH', {version:0,status:'rejected',reviewNote:'Correct the legacy draft'}))
    assert.equal(row.version,1)
    row = expect(await call(0, '/portal/posts/'+draft.id, 'PUT', {...campaign,version:row.version}))
    assert.equal(row.version,2)
    expect(await call(3, '/portal/posts/'+draft.id, 'PATCH', {version:0,status:'approved'}),409)
  })
})
