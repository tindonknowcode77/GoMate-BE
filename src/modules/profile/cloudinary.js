import { randomUUID } from 'node:crypto'
import { v2 as cloudinary } from 'cloudinary'
import { HttpError } from '../../common/http-error.js'

export function createAvatarStorage(config, sdk = cloudinary) {
  const options = { cloud_name: config.cloudinaryCloudName, api_key: config.cloudinaryApiKey,
    api_secret: config.cloudinaryApiSecret, secure: true, timeout: 20000 }
  function assertConfigured() {
    if (!options.cloud_name || !options.api_key || !options.api_secret) {
      throw new HttpError(503, 'Avatar upload is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET on the backend.')
    }
  }
  return {
    assertConfigured,
    async upload(buffer, userId) {
      assertConfigured()
      try {
        const result = await new Promise((resolve, reject) => {
          const stream = sdk.uploader.upload_stream({ ...options, resource_type: 'image',
            public_id: `gomate/avatars/${userId}/${randomUUID()}`, overwrite: false,
          }, (error, value) => error ? reject(error) : resolve(value))
          stream.on('error', reject)
          stream.end(buffer)
        })
        if (!result?.secure_url?.startsWith('https://') || !result.public_id) throw new Error('Invalid upload response')
        return { url: result.secure_url, publicId: result.public_id }
      } catch { throw new HttpError(502, 'Cloudinary upload failed. Please try again.') }
    },
    async remove(publicId) {
      assertConfigured()
      await sdk.uploader.destroy(publicId, { ...options, resource_type: 'image', invalidate: true })
    },
  }
}
