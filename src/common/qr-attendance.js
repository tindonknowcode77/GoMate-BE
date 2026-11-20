import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const FALLBACK_SECRET = randomBytes(32).toString('hex')
const QR_TTL_MS = 120 * 1000 // 2-minute rotating check-in QR window

function secretKey() {
  return process.env.QR_ATTENDANCE_SECRET || process.env.PAYMENT_WEBHOOK_SECRET || FALLBACK_SECRET
}

export function createAttendanceQrToken(activityId, issuedBy, ttlMs = QR_TTL_MS) {
  const issuedAt = Date.now()
  const expiresAt = issuedAt + ttlMs
  const nonce = randomBytes(8).toString('hex')
  const payload = Buffer.from(JSON.stringify({ a: activityId, i: issuedBy, e: expiresAt, n: nonce })).toString('base64url')
  const sig = createHmac('sha256', secretKey()).update(payload).digest('base64url')
  return {
    token: `GMQR1.${payload}.${sig}`,
    activityId,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    ttlSeconds: Math.round(ttlMs / 1000),
  }
}

export function verifyAttendanceQrToken(token, expectedActivityId) {
  if (typeof token !== 'string' || !token.startsWith('GMQR1.')) return { ok: false, reason: 'Mã QR điểm danh không hợp lệ.' }
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'Mã QR điểm danh không hợp lệ.' }
  const [, payload, sig] = parts
  const expectedSig = createHmac('sha256', secretKey()).update(payload).digest('base64url')
  const a = Buffer.from(sig), b = Buffer.from(expectedSig)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'Chữ ký mã QR không hợp lệ.' }
  let data
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch { return { ok: false, reason: 'Dữ liệu mã QR bị lỗi.' } }
  if (!data?.a || !Number.isFinite(data.e)) return { ok: false, reason: 'Dữ liệu mã QR không đầy đủ.' }
  if (expectedActivityId && data.a !== expectedActivityId) return { ok: false, reason: 'Mã QR không thuộc hoạt động này.' }
  if (Date.now() > data.e) return { ok: false, reason: 'Mã QR điểm danh đã hết hạn. Vui lòng yêu cầu host tạo mã mới.' }
  return { ok: true, activityId: data.a, issuedBy: data.i, expiresAt: new Date(data.e) }
}
