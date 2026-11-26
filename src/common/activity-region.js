const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const plain = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')

// Activity fields are authoritative. Fall back to legacy display text only when
// that activity has no structured region; never use a host's profile location.
export function activityRegionConditions(options) {
  return ['province', 'district', 'ward'].flatMap(field => {
    const value = options[field]?.trim()
    if (!value || value === 'Tất cả') return []
    const prefix = field === 'province' ? 'Tỉnh|Thành phố|TP\\.?' : field === 'district' ? 'Quận|Huyện|Thị xã|Thành phố' : 'Phường|Xã|Thị trấn'
    const name = value.replace(new RegExp(`^(?:${prefix})\\s*`, 'iu'), '')
    const aliases = [value, name, plain(name)]
    if (field === 'province' && /^(?:ho chi minh|hcm|tp\.?\s*hcm)$/i.test(plain(name))) aliases.push('Hồ Chí Minh', 'Ho Chi Minh', 'HCM', 'TP.HCM', 'TP. HCM', 'TPHCM')
    const choices = [...new Set(aliases)].map(escape).join('|')
    const exact = `^(?:(?:${prefix})[\\s.]*)?(?:${choices})$`
    const legacyAliases = [...aliases]
    if (field === 'province' && /ho chi minh|hcm/i.test(plain(name))) legacyAliases.push('Thủ Đức', 'Thu Duc')
    if (field === 'province' && /lam dong/i.test(plain(name))) legacyAliases.push('Đà Lạt', 'Da Lat', 'Bảo Lộc', 'Bao Loc')
    const legacy = `(?:^|[\\s,;|/·-])(?:(?:${prefix})[\\s.]*)?(?:${[...new Set(legacyAliases)].map(escape).join('|')})(?=$|[\\s,;|/·-])`
    return [{ $or: [
      { [field]: { $regex: exact, $options: 'i' } },
      { $and: [{ $or: [{ [field]: null }, { [field]: '' }] }, { location: { $regex: legacy, $options: 'i' } }] },
    ] }]
  })
}
