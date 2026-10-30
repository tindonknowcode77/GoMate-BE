import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { PDFDocument } from 'pdf-lib'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { createClient, initializeDatabase } from '../src/database/mongo.js'
import { createAuthRepository } from '../src/modules/auth/repository.js'
import { newToken, hashToken } from '../src/modules/auth/token.js'
import { verificationDocument } from '../src/modules/portal/documents.js'

async function pdfFile(pages) {
  const pdf = await PDFDocument.create()
  for (let i = 0; i < pages; i++) pdf.addPage()
  return { name: 'license.pdf', mime: 'application/pdf', base64: Buffer.from(await pdf.save()).toString('base64') }
}

test('verification documents enforce PDF parsing, 30-page and 10 MB limits', async () => {
  assert.equal((await verificationDocument(await pdfFile(30))).pageCount, 30)
  await assert.rejects(verificationDocument(await pdfFile(31)), /30 trang/)
  await assert.rejects(verificationDocument({ name: 'bad.pdf', mime: 'application/pdf', base64: Buffer.from('%PDF-1.4\nFake').toString('base64') }), /Không đọc được PDF/)
  await assert.rejects(verificationDocument({ name: 'too-big.png', mime: 'image/png', base64: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') }), /10 MB/)
  await assert.rejects(verificationDocument({ name: 'bad.gif', mime: 'image/gif', base64: 'YWJj' }), /JPEG/)
})

test('company and household verification retains private files and immutable certificate identity', async t => {
  const mongo = await MongoMemoryServer.create(); t.after(() => mongo.stop())
  const client = createClient(readConfig({ MONGODB_URI: mongo.getUri('verification') })); await client.connect(); t.after(() => client.close())
  const db = client.db(); await initializeDatabase(db)
  const auth = createAuthRepository(db), tokens = []
  for (const [index, role] of ['user', 'user', 'admin'].entries()) {
    const user = await auth.createUser({ name: 'Test user', email: `verify${index}@example.com`, passwordHash: 'hash' })
    await db.collection('users').updateOne({ id: user.id }, { $set: { email_verified: true, role } })
    const token = newToken(); tokens.push(token); await auth.createSession({ userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 600000) })
  }
  const server = createApp(readConfig({}), { authRepository: auth }).listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)))
  const request = async (path, body, who = 0, method = body ? 'POST' : 'GET') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/portal${path}`, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, body: (response.headers.get('content-type') || '').includes('application/json') ? await response.json() : await response.text() }
  }
  const options = (await request('/options')).body
  assert.ok(options.businessIndustries.includes('Khác')); assert.ok(options.businessIndustries.length > 20)
  const profile = { accountType: 'individual', country: 'VN', certificateNumber: 'HKD-12345', company: 'Hộ kinh doanh thử nghiệm', category: 'Khác', address: '12 Test Street', representativeName: 'Test Owner', representativeTitle: 'Chủ hộ kinh doanh', representativeEmail: 'owner@example.com', representativePhone: '0901234567', document: await pdfFile(1), supplementalDocument: await pdfFile(2) }
  assert.equal((await request('/applications', { ...profile, category: 'unlisted' })).status, 400)
  assert.equal((await request('/applications', { ...profile, country: 'US' })).status, 400)
  assert.equal((await request('/applications', { ...profile, supplementalDocument: await pdfFile(31) })).status, 400)
  let result = await request('/applications', profile); assert.equal(result.status, 201, JSON.stringify(result.body))
  const id = result.body.id
  assert.equal(result.body.document, undefined); assert.equal(result.body.supplementalDocument, undefined)
  assert.equal(result.body.supplementalLicense.name, 'license.pdf')
  assert.equal((await request('/applications', { ...profile, accountType: 'business' }, 1)).status, 409)
  assert.equal((await request(`/applications/${id}/document?kind=supplemental`, undefined, 1)).status, 404)
  assert.equal((await request(`/applications/${id}/document?kind=supplemental`, undefined, 2)).status, 200)
  assert.equal((await request('/applications', undefined, 2)).body.items[0].document, undefined)
  result = await request(`/applications/${id}`, { status: 'rejected', reviewNote: 'Update address', version: 1 }, 2, 'PATCH'); assert.equal(result.status, 200)
  const { document, supplementalDocument, ...resubmit } = profile
  assert.equal((await request('/applications', { ...resubmit, certificateNumber: 'NEW-123', version: 2 })).status, 409)
  assert.equal((await request('/applications', { ...resubmit, accountType: 'business', version: 2 })).status, 409)
  result = await request('/applications', { ...resubmit, address: '20 New Street', version: 2 }); assert.equal(result.status, 201)
  assert.equal(result.body.supplementalLicense.name, 'license.pdf')
  assert.equal((await request(`/applications/${id}/document?kind=supplemental`)).status, 200)
  assert.equal((await request(`/applications/${id}`, { status: 'approved', version: 3 }, 2, 'PATCH')).status, 200)
  assert.equal((await request('/applications', { ...resubmit, company: 'Changed approved name', version: 4 })).status, 403)
  // Two maximum-size uploads must fit without exceeding MongoDB's document limit.
  const image = Buffer.alloc(10 * 1024 * 1024)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image)
  const largeFile = { name: 'proof.png', mime: 'image/png', base64: image.toString('base64') }
  const maximum = await request('/applications', { ...profile, certificateNumber: 'LIMIT-1234', accountType: 'business', document: largeFile, supplementalDocument: largeFile }, 1)
  assert.equal(maximum.status, 201, JSON.stringify(maximum.body))
  assert.equal(maximum.body.license.size, image.length)
  assert.equal(maximum.body.supplementalLicense.size, image.length)
})
