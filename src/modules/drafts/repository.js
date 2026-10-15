import { GridFSBucket } from 'mongodb'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { HttpError } from '../../common/http-error.js'

export function createDraftRepository(db) {
  const records = db.collection('activity_drafts'), bucket = new GridFSBucket(db, { bucketName: 'activity_draft_data' })
  const removeFile = async id => { try { await bucket.delete(id) } catch (error) { if (error.code !== 'ENOENT') console.warn('Draft file cleanup pending') } }
  return {
    async get(ownerId) {
      const row = await records.findOne({ ownerId })
      if (!row) return null
      const chunks = []
      for await (const chunk of bucket.openDownloadStream(row.fileId)) chunks.push(chunk)
      return { version: row.version, savedAt: row.savedAt, state: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    },
    async save(ownerId, state, version) {
      const previous = await records.findOne({ ownerId })
      if ((previous?.version || 0) !== version) throw new HttpError(409, 'Bản nháp đã thay đổi ở phiên khác. Tải lại trước khi lưu.')
      const stream = bucket.openUploadStream(ownerId, { metadata: { ownerId } }), fileId = stream.id
      try {
        await pipeline(Readable.from([Buffer.from(JSON.stringify(state))]), stream)
        const savedAt = new Date()
        if (previous) {
          const result = await records.updateOne({ ownerId, version }, { $set: { fileId, savedAt }, $inc: { version: 1 } })
          if (!result.matchedCount) throw new HttpError(409, 'Bản nháp đã thay đổi ở phiên khác. Tải lại trước khi lưu.')
        } else {
          try { await records.insertOne({ ownerId, fileId, savedAt, version: 1 }) }
          catch (error) { if (error.code === 11000) throw new HttpError(409, 'Đã có bản nháp khác. Tải lại trước khi lưu.'); throw error }
        }
        if (previous) await removeFile(previous.fileId)
        return { version: version + 1, savedAt }
      } catch (error) { await removeFile(fileId); throw error }
    },
    async remove(ownerId, version) {
      const row = await records.findOneAndDelete({ ownerId, version })
      if (!row && await records.findOne({ ownerId })) throw new HttpError(409, 'Bản nháp đã thay đổi ở phiên khác.')
      if (row) await removeFile(row.fileId)
    },
  }
}
