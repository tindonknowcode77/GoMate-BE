import sharp from 'sharp'
import { HttpError } from '../../common/http-error.js'

export function messageContent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['text', 'clientMessageId', 'attachmentIds', 'location'].includes(key)) || typeof body.text !== 'string' || body.text.length > 4000 || typeof body.clientMessageId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.clientMessageId ?? '')) throw new HttpError(400, 'Invalid message')
  const attachmentIds = body.attachmentIds ?? []
  if (!Array.isArray(attachmentIds) || attachmentIds.length > 4 || new Set(attachmentIds).size !== attachmentIds.length || attachmentIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id))) throw new HttpError(400, 'Provide up to four attachments')
  let location = null
  if (body.location !== undefined && body.location !== null) {
    const item = body.location
    if (typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['latitude', 'longitude', 'label'].includes(key)) || !Number.isFinite(item.latitude) || Math.abs(item.latitude) > 90 || !Number.isFinite(item.longitude) || Math.abs(item.longitude) > 180 || typeof item.label !== 'string' || item.label.length > 160) throw new HttpError(400, 'Invalid location')
    location = { latitude: item.latitude, longitude: item.longitude, label: item.label.trim() }
  }
  if (!body.text.trim() && !attachmentIds.length && !location) throw new HttpError(400, 'Message cannot be empty')
  return { text: body.text.trim(), clientMessageId: body.clientMessageId, attachmentIds, location }
}

export function messageLinks(text) {
  return [...new Set((text.match(/https?:\/\/[^\s<>"']+/gi) ?? []).map(value => value.replace(/[.,!?;)\]}]+$/, '')).filter(value => {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && value.length <= 2048 } catch { return false }
  }))].slice(0, 20)
}

// The client MIME is only a hint. Keep active document formats out of previews.
export async function validateUpload(file) {
  if (!file || !file.buffer.length) throw new HttpError(400, 'Select a file')
  const data = file.buffer, head = data.subarray(0, 32), ascii = head.toString('latin1')
  let mimeType, kind = 'file'
  if (head.subarray(0, 3).equals(Buffer.from([255, 216, 255])) || ascii.startsWith('\x89PNG\r\n\x1a\n') || (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP')) {
    try { const info = await sharp(data, { limitInputPixels: 25000000 }).metadata(); if (!['jpeg', 'png', 'webp'].includes(info.format)) throw new Error(); mimeType = `image/${info.format}`; kind = 'image' } catch { throw new HttpError(400, 'Invalid image or image too large') }
  } else if (ascii.slice(4, 8) === 'ftyp') { mimeType = ascii.slice(8, 12).startsWith('qt') ? 'video/quicktime' : 'video/mp4'; kind = 'video' }
  else if (head.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) { mimeType = 'video/webm'; kind = 'video' }
  else if (ascii.startsWith('ID3') || (head[0] === 255 && (head[1] & 224) === 224)) { mimeType = 'audio/mpeg'; kind = 'audio' }
  else if (ascii.startsWith('OggS')) { mimeType = 'audio/ogg'; kind = 'audio' }
  else if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') { mimeType = 'audio/wav'; kind = 'audio' }
  else if (ascii.startsWith('%PDF-')) mimeType = 'application/pdf'
  else if (ascii.startsWith('PK\x03\x04')) mimeType = 'application/zip'
  else if (head.subarray(0, 8).equals(Buffer.from([208, 207, 17, 224, 161, 177, 26, 225]))) mimeType = 'application/octet-stream'
  else if (/\.(txt|csv)$/i.test(file.originalname) && !data.includes(0) && Buffer.from(data.toString('utf8')).equals(data)) mimeType = 'text/plain'
  if (!mimeType) throw new HttpError(400, 'Hỗ trợ JPEG, PNG, WebP, MP4, MOV, WebM, âm thanh, PDF, Office, ZIP và TXT/CSV (tối đa 10 MB).')
  // Browser/native multipart filenames use UTF-8; Busboy's default parameter charset is Latin-1.
  const rawName = Buffer.from(file.originalname, 'latin1'), decodedName = rawName.toString('utf8')
  const name = [...file.originalname].every(char => char.codePointAt(0) <= 255) && Buffer.from(decodedName, 'utf8').equals(rawName) ? decodedName : file.originalname
  return { name: name.replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 120) || 'attachment', size: data.length, mimeType, kind }
}
