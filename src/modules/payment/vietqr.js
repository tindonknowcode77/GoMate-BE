// VietQR / NAPAS 247 EMVCo QR Code generator

export const BANK_BINS = {
  MB: '970422',      // MBBank (Ngân hàng Quân Đội)
  VCB: '970436',     // Vietcombank
  TCB: '970407',     // Techcombank
  ICB: '970415',     // VietinBank
  BIDV: '970418',    // BIDV
  VPB: '970432',     // VPBank
  ACB: '970416',     // ACB
  TPB: '970423',     // TPBank
  HDB: '970437',     // HDBank
  STB: '970403',     // Sacombank
  VIB: '970441',     // VIB
  SHB: '970443',     // SHB
  MSB: '970426',     // MSB
  OCB: '970448',     // OCB
  LPB: '970449',     // LPBank
  SEAB: '970440',    // SeABank
}

export function getBankBin(bankId) {
  if (!bankId) return BANK_BINS.MB
  const upper = String(bankId).trim().toUpperCase()
  return BANK_BINS[upper] || upper
}

export function tlv(tag, value) {
  const str = String(value ?? '')
  const len = String(str.length).padStart(2, '0')
  return `${tag}${len}${str}`
}

export function crc16Ccitt(data) {
  let crc = 0xFFFF
  for (let i = 0; i < data.length; i++) {
    crc ^= data.charCodeAt(i) << 8
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xFFFF
      } else {
        crc = (crc << 1) & 0xFFFF
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}

/**
 * Builds the EMVCo standard payload text for VietQR
 */
export function buildVietQrPayload({ bankBin, accountNo, amount, description }) {
  const bin = String(bankBin).trim()
  const acc = String(accountNo).trim()
  const desc = String(description || '').trim().slice(0, 50)
  const amt = Number(amount) || 0

  // Tag 38: Consumer Account Information (NAPAS)
  // Sub-tag 00: AID A000000727
  // Sub-tag 01: Beneficiary (Sub-sub-tag 00: Bank BIN, Sub-sub-tag 01: Account Number)
  // Sub-tag 02: Service Code (QRIBFTTA for NAPAS 247 Account Transfer)
  const tag38Sub00 = tlv('00', 'A000000727')
  const tag38Sub01 = tlv('01', tlv('00', bin) + tlv('01', acc))
  const tag38Sub02 = tlv('02', 'QRIBFTTA')
  const tag38 = tlv('38', tag38Sub00 + tag38Sub01 + tag38Sub02)

  let payload = ''
  payload += tlv('00', '01')        // Payload Format Indicator
  payload += tlv('01', '12')        // Point of Initiation Method (12 = Dynamic QR)
  payload += tag38
  payload += tlv('53', '704')       // Transaction Currency (704 = VND)
  if (amt > 0) {
    payload += tlv('54', String(amt)) // Transaction Amount
  }
  payload += tlv('58', 'VN')        // Country Code (VN)
  if (desc) {
    payload += tlv('62', tlv('08', desc)) // Additional Data Field (08 = Purpose/Description)
  }
  payload += '6304'                 // CRC Tag and Length

  const checksum = crc16Ccitt(payload)
  return payload + checksum
}

/**
 * Builds the quicklink image URL provided by VietQR
 */
export function buildVietQrImageUrl({ bankId = 'MB', accountNo, template = 'compact2', amount = 0, description = '', accountName = '' }) {
  const cleanBank = String(bankId).trim()
  const cleanAcc = String(accountNo).trim()
  const cleanTemplate = String(template || 'compact2').trim()
  const cleanDesc = encodeURIComponent(String(description || '').trim())
  const cleanName = encodeURIComponent(String(accountName || '').trim())
  const cleanAmount = Number(amount) || 0

  return `https://img.vietqr.io/image/${cleanBank}-${cleanAcc}-${cleanTemplate}.png?amount=${cleanAmount}&addInfo=${cleanDesc}&accountName=${cleanName}`
}

/**
 * Generates an order memo code for bank transfers (e.g. GM718293)
 */
export function generateOrderCode() {
  const digits = Math.floor(100000 + Math.random() * 900000)
  return `GM${digits}`
}

