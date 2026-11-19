import { randomUUID } from 'node:crypto'
import { HttpError } from '../../common/http-error.js'
import { adminText } from './admin-validation.js'

export const systemRoles = [
  { id: 'member', name: 'Thành viên', description: 'Thành viên GoMate', assignable: true },
  { id: 'host', name: 'Host', description: 'Người tổ chức hoạt động', assignable: false },
  { id: 'business', name: 'Doanh nghiệp', description: 'Doanh nghiệp đã được duyệt', assignable: false },
  { id: 'business-staff', name: 'Nhân sự doanh nghiệp', description: 'Nhân sự được phân công', assignable: false },
  { id: 'staff', name: 'Staff', description: 'Vai trò staff hiện có', assignable: false },
  { id: 'admin', name: 'Quản trị viên', description: 'Quản trị hệ thống', assignable: true },
].map(role => ({ ...role, system: true, adminVersion: 0 }))

export function createAdminRoles(db) {
  const roles = db.collection('admin_roles')
  const publicRole = { _id: 0, id: 1, name: 1, description: 1, system: 1, assignable: 1, adminVersion: 1 }
  const active = { deletedAt: { $exists: false } }
  const roleFields = body => {
    const name = adminText(body.name, 'Tên vai trò', 80, { min: 2 })
    const description = adminText(body.description, 'Mô tả', 500, { optional: true })
    return { name, nameKey: name.normalize('NFKC').toLowerCase(), description }
  }
  const writable = id => {
    if (systemRoles.some(role => role.id === id)) throw new HttpError(409, 'Không thể sửa hoặc xóa vai trò hệ thống.')
  }
  return {
    async roles() { return [...systemRoles, ...await roles.find(active, { projection: publicRole }).sort({ name: 1, id: 1 }).toArray()] },
    async resolveRole(id = 'member') {
      if (typeof id !== 'string') throw new HttpError(400, 'Invalid role')
      const role = systemRoles.find(role => role.id === id) || await roles.findOne({ id, ...active }, { projection: publicRole })
      if (!role?.assignable) throw new HttpError(400, 'Vai trò không tồn tại hoặc không thể gán trực tiếp.')
      return { role: id === 'admin' ? 'admin' : 'user', adminRoleId: id }
    },
    async saveRole(id, expected, body, actorId) {
      if (id) writable(id)
      const data = roleFields(body)
      if (systemRoles.some(role => role.name.normalize('NFKC').toLowerCase() === data.nameKey)) throw new HttpError(409, 'Tên vai trò đã tồn tại.')
      const now = new Date()
      try {
        if (!id) {
          const row = { id: 'custom-' + randomUUID(), ...data, system: false, assignable: true, adminVersion: 1, createdAt: now, updatedBy: actorId }
          await roles.insertOne(row)
          return roles.findOne({ id: row.id }, { projection: publicRole })
        }
        const row = await roles.findOneAndUpdate({ id, ...active, adminVersion: expected }, { $set: { ...data, updatedAt: now, updatedBy: actorId }, $inc: { adminVersion: 1 } }, { returnDocument: 'after', projection: publicRole })
        if (!row) throw new HttpError(409, 'Vai trò đã thay đổi hoặc không còn tồn tại.')
        return row
      } catch (error) { if (error.code === 11000) throw new HttpError(409, 'Tên vai trò đã tồn tại.'); throw error }
    },
    async deleteRole(id, expected, actorId) {
      writable(id)
      if (await db.collection('users').findOne({ adminRoleId: id, ...active })) throw new HttpError(409, 'Vai trò đang được gán cho thành viên.')
      const row = await roles.findOneAndUpdate({ id, ...active, adminVersion: expected }, { $set: { nameKey: 'deleted:' + id, deletedAt: new Date(), updatedBy: actorId }, $inc: { adminVersion: 1 } }, { returnDocument: 'after', projection: publicRole })
      if (!row) throw new HttpError(409, 'Vai trò đã thay đổi hoặc không còn tồn tại.')
      return { id, deleted: true }
    },
  }
}
