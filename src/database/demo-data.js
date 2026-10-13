import { hashPassword } from '../modules/auth/password.js'
import { activityFields } from '../modules/activities/validation.js'
import { activityImages, demoMembers, legacyDemoPortraits } from './demo-media.js'
import { canParticipate } from '../common/preferences.js'

const templates = [
  ['Cà phê làm quen ở Thảo Điền', 'Ăn uống', 'Thảo Điền, TP. Thủ Đức', '09:00', 80000, 'Trò chuyện', 106.733, 10.803],
  ['Chạy bộ buổi sáng ở công viên Tao Đàn', 'Thể thao', 'Công viên Tao Đàn, Quận 1', '06:15', 0, 'Chạy bộ', 106.686, 10.776],
  ['Cầu lông sau giờ làm tại Bình Thạnh', 'Thể thao', 'Bình Thạnh', '19:00', 90000, 'Cầu lông', 106.709, 10.805],
  ['English coffee ở Quận 3', 'Học tập', 'Quận 3', '10:30', 70000, 'English', 106.681, 10.786],
  ['Board game tối cuối tuần ở Phú Nhuận', 'Gaming', 'Phú Nhuận', '19:30', 100000, 'Board game', 106.677, 10.799],
  ['Đi bộ và chụp ảnh ở bến Bạch Đằng', 'Du lịch', 'Bến Bạch Đằng, Quận 1', '16:30', 0, 'Nhiếp ảnh', 106.707, 10.773],
  ['Khám phá ẩm thực Chợ Lớn', 'Ăn uống', 'Chợ Lớn, Quận 5', '17:00', 180000, 'Ẩm thực', 106.668, 10.755],
  ['Yoga nhẹ nhàng ở công viên Gia Định', 'Thể thao', 'Công viên Gia Định, Gò Vấp', '07:00', 0, 'Yoga', 106.676, 10.815],
  ['Đọc sách và chia sẻ ở Quận 1', 'Học tập', 'Đường sách Nguyễn Văn Bình, Quận 1', '09:30', 60000, 'Đọc sách', 106.701, 10.78],
  ['Picnic và trò chuyện ở công viên Lê Văn Tám', 'Giải trí', 'Công viên Lê Văn Tám, Quận 1', '15:00', 60000, 'Picnic', 106.693, 10.787],
  ['Đạp xe thư giãn ở khu Phú Mỹ Hưng', 'Thể thao', 'Phú Mỹ Hưng, Quận 7', '06:30', 0, 'Đạp xe', 106.717, 10.731],
  ['Workshop vẽ màu nước cho người mới', 'Giải trí', 'Quận 3', '14:00', 150000, 'Nghệ thuật', 106.683, 10.788],
  ['Tìm bạn học và làm việc ở Tân Bình', 'Học tập', 'Tân Bình', '08:30', 60000, 'Co-working', 106.654, 10.801],
  ['Xem phim và bàn luận cùng nhóm nhỏ', 'Giải trí', 'Quận 10', '18:30', 160000, 'Điện ảnh', 106.666, 10.774],
  ['Pickleball giao lưu tại TP. Thủ Đức', 'Thể thao', 'TP. Thủ Đức', '17:30', 120000, 'Pickleball', 106.744, 10.823],
  ['Dạo phố và chụp ảnh kiến trúc Sài Gòn', 'Du lịch', 'Khu trung tâm Quận 1', '08:00', 0, 'Khám phá', 106.698, 10.774],
  ['Âm nhạc acoustic và kết bạn ở Bình Thạnh', 'Giải trí', 'Bình Thạnh', '20:00', 100000, 'Âm nhạc', 106.704, 10.812],
  ['Bữa tối món Việt ở Quận 4', 'Ăn uống', 'Quận 4', '18:00', 150000, 'Ăn tối', 106.706, 10.758],
  ['Giao lưu gaming tại Quận 10', 'Gaming', 'Quận 10', '14:30', 80000, 'Gaming', 106.671, 10.773],
  ['Tối trò chuyện và đồ uống ở Quận 2', 'Ăn uống', 'An Phú, TP. Thủ Đức', '19:15', 200000, 'Trò chuyện', 106.749, 10.797],
]

export async function seedDemo(db, { now = new Date(), password = 'gomate123' } = {}) {
  const passwordHash = await hashPassword(password)
  const users = [
    { id: '00000000-0000-4000-8000-000000000001', email: 'demo@gomate.local', name: 'Bạn Demo' },
    ...['Minh Anh', 'Tuấn Kiệt', 'Linh Nguyễn'].map((name, index) => ({ id: `00000000-0000-4000-8000-00000000000${index + 2}`, email: `host${index + 1}@gomate.local`, name })),
    ...demoMembers,
  ]
  for (const [index, user] of users.entries()) {
    const existing = await db.collection('users').findOne({ email: user.email })
    if (existing && existing.id !== user.id) throw new Error(`Demo email already belongs to a different account: ${user.email}`)
    await db.collection('users').updateOne({ id: user.id }, { $setOnInsert: { ...user, password_hash: passwordHash, email_verified: true,
      credential_version: 0, created_at: now, updated_at: now, demo: true,
      ...(index < 4 ? { location: 'TP. Hồ Chí Minh', bio: 'Hồ sơ demo yêu thích kết nối và trải nghiệm cùng nhóm nhỏ.', interests: ['Cà phê', 'Du lịch', 'Cầu lông'], languages: ['Tiếng Việt', 'English'], gender: index === 2 ? 'male' : 'female', religion: 'none', alcohol: 'yes', birthDate: '1998-06-15' } : {}),
    } }, { upsert: true })
    // Enrich missing fields only on explicitly marked demo accounts; preserve user edits and passwords.
    const saved = await db.collection('users').findOne({ id: user.id, demo: true })
    if (saved) {
      const sample = index < 4 ? { ...demoMembers[[6, 0, 1, 2][index]], username: `demo_host_${index}`, name: user.name, avatar_url: legacyDemoPortraits[index] } : user
      const missing = {}
      for (const key of ['username', 'bio', 'location', 'birthDate', 'gender', 'religion', 'alcohol', 'interests', 'languages', 'avatar_url', 'cover_url', 'occupation', 'media_source']) {
        if (!saved[key] || (Array.isArray(saved[key]) && !saved[key].length)) missing[key] = sample[key]
      }
      if (index < 4 && !saved.avatar_public_id && demoMembers.some(member => member.avatar_url === saved.avatar_url)) missing.avatar_url = sample.avatar_url
      if (Object.keys(missing).length) await db.collection('users').updateOne({ id: user.id, demo: true }, { $set: missing })
    }
  }
  let created = 0
  const vietnamDay = new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 10)
  for (const [index, [title, category, place, time, cost, theme, lng, lat]] of templates.entries()) {
    const day = new Date(`${vietnamDay}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1 + Math.floor(index / 2))
    const startsAt = new Date(`${day.toISOString().slice(0, 10)}T${time}:00+07:00`)
    const endsAt = new Date(startsAt.getTime() + 2 * 3600000)
    const deadline = new Date(startsAt.getTime() - 3600000)
    const host = users[1 + index % 3]
    const fields = activityFields({ title, category, location: `${place}, TP. Hồ Chí Minh`,
      description: `Cùng nhóm nhỏ trải nghiệm ${theme.toLowerCase()}, làm quen và chia sẻ sở thích. Phù hợp cả người mới. Đây là dữ liệu DEMO, chưa phải sự kiện được tổ chức thật.`,
      startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), registrationDeadline: deadline.toISOString(),
      estimatedCost: cost, minParticipants: 2 + index % 3, maxParticipants: 6 + index % 5, meetingPoint: `Host sẽ xác nhận điểm gặp cụ thể tại ${place} trong nhóm.`,
      coordinates: { type: 'Point', coordinates: [lng, lat] }, tags: ['Demo', theme],
      requirements: ['Đến đúng giờ', 'Tôn trọng các thành viên'], plan: [`${time} Tập trung và làm quen`, 'Trải nghiệm cùng nhóm', 'Chụp ảnh và tổng kết'],
      participantPreferences: { genders: index === 7 ? ['female'] : [], languages: index === 3 ? ['English'] : [], religions: [], alcohol: index === 19 ? 'yes' : 'any', dressCode: category === 'Thể thao' ? 'Trang phục thoải mái, giày thể thao' : '' },
      financialConfig: { fundingMode: 'FULL_PREPAYMENT', estimatedCostPerMember: cost, paymentDeadline: deadline.toISOString(), treasurerUserId: host.id, approvalThreshold: 1000000, approvalRule: 'MAJORITY' },
    })
    const id = `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
    const result = await db.collection('activities').updateOne({ id }, { $setOnInsert: { id, ...fields, hostId: host.id, hostName: host.name, status: 'published',
      memberCount: 1, version: 1, createdAt: now, updatedAt: now, demo: true } }, { upsert: true })
    created += result.upsertedCount
    let current = await db.collection('activities').findOne({ id, demo: true })
    if (!current || current.status !== 'published') continue
    if (!current.imageUrl) await db.collection('activities').updateOne({ id, demo: true, imageUrl: { $exists: false }, imagePublicId: { $exists: false } },
      { $set: { imageUrl: activityImages[index], imageSource: 'Unsplash', updatedAt: now }, $inc: { version: 1 } })
    current = await db.collection('activities').findOne({ id, demo: true })
    if (current.demoRosterVersion !== 1) {
      const existing = current.joinRequests ?? []
      const eligible = demoMembers.filter(member => member.id !== current.hostId && canParticipate(current.participantPreferences, member))
      const ordered = [...eligible.slice(index % eligible.length), ...eligible.slice(0, index % eligible.length)]
      const used = new Set(existing.map(request => request.userId))
      const approved = existing.filter(request => request.status === 'approved').length
      const needed = Math.max(0, Math.min(2 + index % 3, current.maxParticipants - 2) - approved)
      const added = []
      for (const member of ordered) {
        if (used.has(member.id) || added.filter(request => request.status === 'approved').length >= needed) continue
        used.add(member.id)
        added.push({ id: `20000000-0000-4000-8000-${String(index * 100 + demoMembers.indexOf(member) + 1).padStart(12, '0')}`, userId: member.id, name: member.name,
          status: 'approved', demo: true, createdAt: new Date(now.getTime() - 86400000), updatedAt: now })
      }
      const pending = 1 + approved + added.length < current.maxParticipants ? ordered.find(member => !used.has(member.id)) : null
      if (pending) added.push({ id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, userId: pending.id, name: pending.name, status: 'pending', demo: true, createdAt: now, updatedAt: now })
      await db.collection('activities').updateOne({ id, demo: true, version: current.version, demoRosterVersion: { $ne: 1 } },
        { $set: { joinRequests: [...existing, ...added], memberCount: 1 + approved + added.filter(request => request.status === 'approved').length, demoRosterVersion: 1, updatedAt: now }, $inc: { version: 1 } })
    }
  }
  return { created, total: templates.length, users: users.length, accounts: users.map(({ email }) => email) }
}
