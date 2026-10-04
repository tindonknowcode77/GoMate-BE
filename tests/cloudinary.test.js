import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Writable } from 'node:stream'
import { createAvatarStorage } from '../src/modules/profile/cloudinary.js'

test('Cloudinary upload requires configuration without calling the provider', async () => {
  const storage = createAvatarStorage({}, {})
  await assert.rejects(storage.upload(Buffer.from('image'), 'user'), { status: 503 })
})

test('Cloudinary uses server credentials, unique public IDs and sanitized failures', async () => {
  const uploads = [], removed = []
  let fails = false
  const sdk = { uploader: {
    upload_stream(options, callback) {
      uploads.push(options)
      return new Writable({ write(chunk, encoding, done) {
        assert.equal(chunk.toString(), 'image')
        done()
        callback(fails ? new Error('secret-provider-error') : null,
          { secure_url: 'https://res.cloudinary.com/test/image/upload/avatar.webp', public_id: options.public_id })
      } })
    },
    async destroy(publicId, options) { removed.push({ publicId, options }) },
  } }
  const storage = createAvatarStorage({ cloudinaryCloudName: 'test', cloudinaryApiKey: 'key', cloudinaryApiSecret: 'secret' }, sdk)
  const first = await storage.upload(Buffer.from('image'), 'user1')
  const second = await storage.upload(Buffer.from('image'), 'user1')
  assert.notEqual(first.publicId, second.publicId)
  assert.match(first.publicId, /^gomate\/avatars\/user1\//)
  assert.equal(uploads[0].api_secret, 'secret')
  assert.equal(uploads[0].overwrite, false)
  await storage.remove(first.publicId)
  assert.equal(removed[0].publicId, first.publicId)
  assert.equal(removed[0].options.invalidate, true)
  fails = true
  await assert.rejects(storage.upload(Buffer.from('image'), 'user1'), error => error.status === 502 && !error.message.includes('secret'))
})
