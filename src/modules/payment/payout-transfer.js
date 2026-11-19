import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { HttpError } from '../../common/http-error.js'
import { buildVietQrImageUrl, buildVietQrPayload, getBankBin } from './vietqr.js'

export function payoutTransfer(payout) {
  const bank = payout.bankAccount, bankBin = getBankBin(bank?.bankId === 'CTG' ? 'ICB' : bank?.bankId)
  if (!bank?.bankId || !/^\d{6}$/.test(bankBin) || !/^\d{6,25}$/.test(bank.accountNo || '') || !bank.accountName) throw new HttpError(400, 'Tài khoản nhận giải ngân chưa đủ thông tin ngân hàng để tạo VietQR.')
  if (!Number.isSafeInteger(payout.amount) || payout.amount <= 0) throw new HttpError(409, 'Số tiền giải ngân không hợp lệ.')
  const description = payout.transferMemo || payout.referenceCode || `PO${createHash('sha256').update(payout.id).digest('hex').slice(0, 16).toUpperCase()}`
  return {
    bankAccount: bank, amount: payout.amount, description,
    qrImageUrl: buildVietQrImageUrl({ bankId: bankBin, accountNo: bank.accountNo, accountName: bank.accountName, amount: payout.amount, description }),
    qrPayload: buildVietQrPayload({ bankBin, accountNo: bank.accountNo, amount: payout.amount, description }),
  }
}

export async function payoutReceipt(value) {
  const invalid = message => { throw new HttpError(400, message) }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['name', 'mime', 'base64'].includes(key))) invalid('Hãy tải ảnh bill chuyển khoản lên.')
  const { name, mime, base64 } = value
  const formats = { 'image/png': ['png', 'png'], 'image/jpeg': ['jpe?g', 'jpeg'], 'image/webp': ['webp', 'webp'] }
  if (typeof name !== 'string' || !name.trim() || name.length > 180 || /[\/\\\x00-\x1f]/.test(name) || !Object.hasOwn(formats, mime) || !new RegExp(`\\.${formats[mime][0]}$`, 'i').test(name)) invalid('Bill phải là ảnh PNG, JPG hoặc WEBP, tối đa 5 MB.')
  if (typeof base64 !== 'string' || base64.length > 6990508 || base64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) invalid('Ảnh bill không hợp lệ hoặc vượt quá 5 MB.')
  const input = Buffer.from(base64, 'base64')
  if (!input.length || input.length > 5 * 1024 * 1024 || input.toString('base64') !== base64) invalid('Ảnh bill không hợp lệ hoặc vượt quá 5 MB.')
  let bytes
  try {
    const image = sharp(input, { limitInputPixels: 20000000, failOn: 'warning' }), info = await image.metadata()
    if (info.format !== formats[mime][1] || (info.pages || 1) !== 1) throw new Error('Invalid receipt image')
    bytes = await image.rotate().resize({ width: 2200, height: 6000, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer()
  } catch { invalid('Không đọc được ảnh bill. Hãy chọn ảnh PNG, JPG hoặc WEBP hợp lệ, tối đa 20 triệu điểm ảnh.') }
  if (bytes.length > 5 * 1024 * 1024) invalid('Ảnh bill sau xử lý vượt quá 5 MB. Hãy chọn ảnh nhỏ hơn.')
  return { id: createHash('sha256').update(input).digest('hex'), name: name.trim().replace(/\.[^.]+$/, '.jpg'), mime: 'image/jpeg', size: bytes.length, base64: bytes.toString('base64') }
}
