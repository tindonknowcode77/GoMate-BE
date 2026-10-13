import nodemailer from 'nodemailer'
import { HttpError } from '../../common/http-error.js'

export function createVerificationMailer(config, createTransport = nodemailer.createTransport) {
  const ready = Boolean(config.smtpHost && config.smtpUser && config.smtpPass && config.mailFrom)
  const transport = ready ? createTransport({
    host: config.smtpHost, port: config.smtpPort, secure: config.smtpPort === 465,
    requireTLS: config.smtpPort !== 465,
    auth: { user: config.smtpUser, pass: config.smtpPass },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
  }) : null
  return {
    assertConfigured() {
      if (!ready) throw new HttpError(503, 'Email delivery is not configured')
    },
    async sendCode(email, code) {
      this.assertConfigured()
      try {
        const result = await transport.sendMail({
          from: config.mailFrom, to: email,
          subject: 'GoMate - Ma xac minh email',
          text: `Ma xac minh GoMate cua ban: ${code}\nMa co hieu luc 10 phut. Khong chia se ma nay.\nNeu ban khong dang ky GoMate, hay bo qua email nay.`,
        })
        if (!result.accepted?.length) throw new Error('Recipient rejected')
      } catch {
        throw new HttpError(503, 'Could not send verification email. Please request a new code later.')
      }
    },
    async sendResetCode(email, code) {
      this.assertConfigured()
      try {
        const result = await transport.sendMail({ from: config.mailFrom, to: email,
          subject: 'GoMate - Dat lai mat khau',
          text: `Ma dat lai mat khau GoMate: ${code}\nMa co hieu luc 10 phut. Khong chia se ma nay.\nNeu ban khong yeu cau dat lai mat khau, hay bo qua email nay.`,
        })
        if (!result.accepted?.length) throw new Error('Recipient rejected')
      } catch { throw new HttpError(503, 'Could not send password reset email') }
    },
  }
}
