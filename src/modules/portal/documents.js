import { PDFDocument } from 'pdf-lib'
import { HttpError } from '../../common/http-error.js'

export async function verificationDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['name', 'mime', 'base64'].includes(key))) throw new HttpError(400, 'Tài liệu không hợp lệ.')
  const { name, mime, base64 } = value
  if (typeof name !== 'string' || !name.trim() || name.length > 180 || !/\.(pdf|png|jpe?g)$/i.test(name) || !['application/pdf', 'image/png', 'image/jpeg'].includes(mime)) throw new HttpError(400, 'Chỉ hỗ trợ JPEG, PNG, PDF và JPG.')
  if (typeof base64 !== 'string' || base64.length > 13981016 || base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new HttpError(400, 'Tài liệu không hợp lệ hoặc vượt quá 10 MB.')
  const bytes = Buffer.from(base64, 'base64')
  if (!bytes.length || bytes.length > 10 * 1024 * 1024 || bytes.toString('base64') !== base64) throw new HttpError(400, 'Tài liệu không hợp lệ hoặc vượt quá 10 MB.')
  const extension = name.split('.').at(-1).toLowerCase()
  const valid = mime === 'application/pdf' ? extension === 'pdf' && bytes.subarray(0, 5).toString() === '%PDF-' : mime === 'image/png' ? extension === 'png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : ['jpg', 'jpeg'].includes(extension) && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if (!valid) throw new HttpError(400, 'Định dạng tệp không khớp với nội dung tài liệu.')
  let pageCount
  if (mime === 'application/pdf') {
    try { const pdf = await PDFDocument.load(bytes, { throwOnInvalidObject: true }); pageCount = pdf.getPageCount() } catch { throw new HttpError(400, 'Không đọc được PDF. Vui lòng dùng tệp PDF hợp lệ, không có mật khẩu.') }
    if (pageCount < 1 || pageCount > 30) throw new HttpError(400, 'Tệp PDF phải có từ 1 đến 30 trang.')
  }
  return { name: name.trim(), mime, base64, ...(pageCount ? { pageCount } : {}) }
}
