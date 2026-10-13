import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createVerificationMailer } from '../src/modules/auth/email.js'

test('mailer fails closed when SMTP is missing', async () => {
  const mailer = createVerificationMailer({})
  assert.throws(() => mailer.assertConfigured(), { status: 503 })
  await assert.rejects(mailer.sendCode('user@example.com', '123456'), { status: 503 })
  await assert.rejects(mailer.sendResetCode('user@example.com', '123456'), { status: 503 })
})

test('mailer addresses the user, uses TLS and handles SMTP rejection without leaking details', async () => {
  let reject = false
  const mailer = createVerificationMailer({ smtpHost: 'smtp.example.com', smtpPort: 587,
    smtpUser: 'sender', smtpPass: 'private', mailFrom: 'sender@example.com',
  }, options => {
    assert.equal(options.requireTLS, true)
    assert.equal(options.secure, false)
    return { async sendMail(message) {
      assert.equal(message.to, 'user@example.com')
      assert.equal(message.from, 'sender@example.com')
      assert.match(message.text, /123456/)
      if (reject) throw new Error('private SMTP credentials')
      return { accepted: ['user@example.com'] }
    } }
  })
  await mailer.sendCode('user@example.com', '123456')
  await mailer.sendResetCode('user@example.com', '123456')
  reject = true
  await assert.rejects(mailer.sendCode('user@example.com', '123456'), error =>
    error.status === 503 && !error.message.includes('private'))
  await assert.rejects(mailer.sendResetCode('user@example.com', '123456'), error =>
    error.status === 503 && !error.message.includes('private'))
})
