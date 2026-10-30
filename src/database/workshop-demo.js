import { ensureWorkshopAdmin } from './workshop-demo-admin.js'
import { hashPassword } from '../modules/auth/password.js'
import { createAuthRepository } from '../modules/auth/repository.js'
import { createActivityRepository } from '../modules/activities/repository.js'

export const workshopAccounts = [
  { key: 'host', name: 'Mai · Demo Host', email: 'demo.host@gomate.local', role: 'user' },
  { key: 'member', name: 'An · Demo Member', email: 'demo.member@gomate.local', role: 'user' },
  { key: 'business', name: 'GoMate Studio · Demo', email: 'demo.business@gomate.local', role: 'user' },
  { key: 'admin', name: 'Linh · Demo Admin', email: 'demo.admin@gomate.local', role: 'admin' },
  { key: 'newbusiness', name: 'Đối tác mới · Demo', email: 'demo.newbusiness@gomate.local', role: 'user' },
]
export async function seedWorkshopDemo(db, { password = 'DemoGoMate123!' } = {}) {
  const auth = createAuthRepository(db), activities = createActivityRepository(db), people = {}
  const passwordHash = await hashPassword(password)
  for (const account of workshopAccounts) {
    if (account.key === 'admin') { people.admin = await ensureWorkshopAdmin(db, { password }); continue; }
    let user = await db.collection('users').findOne({ email: account.email })
    if (user && user.demoScenario !== 'workshop') throw Error(`Refusing to change an existing non-demo account: ${account.email}`)
    if (!user) {
      user = await auth.createUser({ name: account.name, email: account.email, passwordHash })
      await db.collection('users').updateOne({ id: user.id }, { $set: { demoScenario: 'workshop', role: account.role, email_verified: true, birthDate: '1999-01-01', gender: 'undisclosed', location: 'TP. Hồ Chí Minh', bio: 'Tài khoản minh họa GoMate', interests: ['Cà phê', 'Workshop'], languages: ['Tiếng Việt'], username: 'gomate_demo_' + account.key } })
    }
    people[account.key] = user
  }
  const host = people.host, member = people.member
  if ((await auth.friendship(host.id, member.id)).status !== 'accepted') {
    // Friendship is seeded directly; no email, invitation or external message is sent.
    const request = await auth.friendRequest(host.id, member.id)
    if (request?.id) await auth.decideFriend(member.id, request.id, 'accepted')
  }
  const now = new Date(), startsAt = new Date(now.getTime() + 2 * 86400000), endsAt = new Date(startsAt.getTime() + 2 * 3600000)
  const base = { description: 'Bài mẫu để demo tìm kiếm, đăng ký, chat và điểm danh trên hai trình duyệt.', category: 'Cà phê', location: 'TP. Hồ Chí Minh', meetingPoint: 'Sảnh chính · GoMate Demo', startsAt, endsAt, estimatedCost: 50000, maxParticipants: 8, demoScenario: 'workshop', plan: ['Tập trung và làm quen', 'Trải nghiệm cùng nhóm', 'Tổng kết và đánh giá'] }
  let personal = await db.collection('activities').findOne({ demoScenario: 'workshop', hostId: host.id, status: 'published', startsAt: { $gt: now } })
  if (!personal) personal = await activities.create({ ...base, title: 'DEMO · Cà phê kết bạn' }, host)
  let application = await db.collection('business_applications').findOne({ ownerId: people.business.id })
  if (!application) application = await auth.portal.apply(people.business.id, { company: 'GoMate Studio · Demo', category: 'Workshop', website: '', document: { name: 'demo.pdf', mime: 'application/pdf', base64: Buffer.from('%PDF-1.4\nGoMate demo verification document').toString('base64') } })
  if (application.status === 'pending') await auth.portal.decideApplication(application.id, 'approved', 'Hồ sơ minh họa cho demo local', people.admin.id)
  let business = await db.collection('activities').findOne({ hostId: people.business.id, organizerType: 'business', status: 'published', startsAt: { $gt: now } })
  if (!business) {
    const { demoScenario: _demoScenario, ...eventBase } = base
    let post = await db.collection('business_posts').findOne({ ownerId: people.business.id, title: 'DEMO · Workshop làm gốm -20%', status: 'pending' })
    if (post?.event?.demoScenario === 'workshop') { await db.collection('business_posts').updateOne({ id: post.id }, { $unset: { 'event.demoScenario': '' } }); delete post.event.demoScenario }
    post ??= await auth.portal.createPost(people.business.id, { title: 'DEMO · Workshop làm gốm -20%', copy: 'Trải nghiệm làm gốm cùng GoMate Studio. Bài minh họa, không phải ưu đãi thương mại thật.', badge: 'Demo', discount: 'Giảm 20%', premium: false, border: 'Solid', discountPercent: 20, offer: 'Tặng một đồ uống cho thành viên GoMate', offerTerms: 'Mẫu demo; không phát sinh thanh toán.', event: { ...eventBase, title: 'DEMO · Workshop làm gốm -20%', category: 'Workshop', description: 'Sự kiện doanh nghiệp minh họa', estimatedCost: 120000 } })
    const approved = await auth.portal.decidePost(post.id, 'approved', 'Bài minh họa cho demo local', people.admin.id)
    business = await activities.get(approved.activityId)
  }
  return { accounts: workshopAccounts, personalId: personal.id, businessId: business.id }
}
