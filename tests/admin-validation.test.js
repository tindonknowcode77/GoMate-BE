import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adminQuery, adminText, adminId, adminPostFields, adminApplicationFields } from '../src/modules/portal/admin-validation.js'
import { version } from '../src/modules/portal/validation.js'

const bad = operation => assert.throws(operation, error => error.status === 400)

test('admin query rejects ambiguous pagination, unknown filters and query injection', () => {
  for (const page of ['', '0', '-1', '1.5', '1e2', ' 1 ', '01', '10001', ['1', '2'], { $gt: 0 }, null]) bad(() => adminQuery('users', { page }))
  for (const query of [{ q: ['x', 'y'] }, { q: { $regex: '.*' } }, { q: 'a'.repeat(121) }, { status: 'deleted' }, { status: 'admin' }, { sort: 'email' }]) bad(() => adminQuery('users', query))
  for (const kind of ['businesses', 'posts', 'reports', 'tickets']) bad(() => adminQuery(kind, { status: 'invalid' }))
  assert.deepEqual(adminQuery('posts', { page: '10000', q: '  literal.*  ', status: ' pending ' }), { page: 10000, q: 'literal.*', status: 'pending' })
  assert.deepEqual(adminQuery('users', { q: '   ', status: '' }), { page: 1, q: '', status: '' })
  assert.deepEqual(adminQuery('posts', { page: '1', q: '', status: '', role: '' }), { page: 1, q: '', status: '' })
  assert.equal(adminQuery('users', { role: ' business-staff ' }).role, 'business-staff')
  for (const role of ['unknown', ['admin', 'user'], { $ne: '' }, null]) bad(() => adminQuery('users', { role }))
  for (const kind of ['posts', 'businesses', 'reports', 'tickets']) bad(() => adminQuery(kind, { role: 'admin' }))
})

test('admin strings, identifiers and revisions enforce type, bounds and control characters', () => {
  for (const value of [null, {}, [], 12, '', ' ', 'A', 'x'.repeat(101), 'AB\u0000CD']) bad(() => adminText(value, 'Họ tên', 100, { min: 2 }))
  assert.equal(adminText('  Nguyễn Văn An  ', 'Họ tên', 100, { min: 2 }), 'Nguyễn Văn An')
  assert.equal(adminText(' \n ', 'Mô tả', 1000, { optional: true }), '')
  for (const id of ['', ' ', {}, 'bad/id', '$ne', 'a.b', 'a'.repeat(101)]) bad(() => adminId(id))
  assert.equal(adminId(' owner-123 '), 'owner-123')
  for (const value of [-1, 0.1, '1', null, Number.MAX_SAFE_INTEGER + 1]) bad(() => version(value))
  assert.equal(version(0), 0)
})

test('admin post schema validates nested payloads, numeric discounts and immutable fields', () => {
  const valid = { title: 'Title', copy: 'Content', premium: false, border: 'Solid' }
  for (const value of [null, [], {}, { ...valid, title: ' ' }, { ...valid, copy: 'a'.repeat(3001) }, { ...valid, title: 'X\u0000' }, { ...valid, ownerId: 'other' }, { ...valid, version: 1 }, { ...valid, status: 'approved' }, { ...valid, premium: 'false' }, { ...valid, border: 'bad' }, { ...valid, groups: [] }, { ...valid, groups: [null] }, { ...valid, event: {} }]) bad(() => adminPostFields(value))
  for (const discountPercent of [-1, 101, 0.5, '10', null, {}]) {
    bad(() => adminPostFields({ ...valid, discountPercent }))
  }
  assert.equal(adminPostFields({ ...valid, offer: ' \n ', discountPercent: 100 }).offer, '')
  assert.equal(adminPostFields({ ...valid, discountPercent: 0 }).discountPercent, 0)
})

test('admin business schema rejects malformed identity, contact, URL and nested data', () => {
  const valid = { company: 'Business', category: 'Events', taxId: '0312345678', address: 'Address', representativeName: 'Owner', representativeTitle: 'Director', representativeEmail: 'owner@example.com', representativePhone: '+84901234567' }
  for (const value of [null, [], { ...valid, status: 'approved' }, { ...valid, taxId: '123' }, { ...valid, representativeEmail: 'invalid' }, { ...valid, representativePhone: 'abc' }, { ...valid, website: 'javascript:alert(1)' }, { ...valid, website: 'https://user:pass@example.com' }, { ...valid, company: ' ' }, { ...valid, company: 'A\u0000B' }]) bad(() => adminApplicationFields(value))
  assert.equal(adminApplicationFields({ ...valid, website: '   ' }).website, '')
})
