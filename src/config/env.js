export function readConfig(env = process.env) {
  const port = Number(env.PORT ?? 3000)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535')
  }
  const sessionTtlHours = Number(env.SESSION_TTL_HOURS ?? 24)
  if (!Number.isInteger(sessionTtlHours) || sessionTtlHours < 1 || sessionTtlHours > 720) {
    throw new Error('SESSION_TTL_HOURS must be an integer between 1 and 720')
  }
  const trustProxyHops = Number(env.TRUST_PROXY_HOPS ?? 0)
  const rememberSessionTtlHours = Number(env.REMEMBER_SESSION_TTL_HOURS ?? 720)
  if (!Number.isInteger(rememberSessionTtlHours) || rememberSessionTtlHours < sessionTtlHours || rememberSessionTtlHours > 720) {
    throw new Error('REMEMBER_SESSION_TTL_HOURS must be an integer between SESSION_TTL_HOURS and 720')
  }
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 5) {
    throw new Error('TRUST_PROXY_HOPS must be an integer between 0 and 5')
  }
  return {
    cloudinaryCloudName: env.CLOUDINARY_CLOUD_NAME?.trim(),
    cloudinaryApiKey: env.CLOUDINARY_API_KEY?.trim(),
    cloudinaryApiSecret: env.CLOUDINARY_API_SECRET?.trim(),
    smtpHost: env.SMTP_HOST || 'smtp.gmail.com',
    smtpPort: (() => {
      const value = Number(env.SMTP_PORT || 465)
      if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('Invalid SMTP_PORT')
      return value
    })(),
    smtpUser: env.SMTP_USER,
    smtpPass: env.SMTP_PASS,
    mailFrom: env.MAIL_FROM || env.SMTP_USER,
    mongodbUri: env.MONGODB_URI,
    googleClientId: env.GOOGLE_CLIENT_ID?.trim() || '',
    sessionTtlHours,
    rememberSessionTtlHours,
    trustProxyHops,
    port,
    host: env.HOST || (env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
    corsOrigin: env.CORS_ORIGIN || 'http://localhost:5173',
  }
}
