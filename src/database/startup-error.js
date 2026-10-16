// Never print the raw driver error: it may contain connection details or user data.
export function databaseStartupError(error, phase) {
  const code = error?.code ?? error?.cause?.code
  const dns = ['querySrv', 'queryTxt'].includes(error?.syscall)
  if (dns) return `MongoDB DNS lookup failed (${code || 'DNS_ERROR'}). Check the DNS resolver, VPN or local DNS service used by Node.js. The database has not been contacted yet.`
  if (code === 18) return 'MongoDB authentication failed. Check the database username/password and authSource in MONGODB_URI.'
  if (code === 13) return 'MongoDB access denied. Check the database user permissions for the configured database and index creation.'
  if (phase === 'initialization') {
    if (code === 11000) return 'MongoDB connected, but a unique index could not be created because existing records contain duplicate values. Review the affected collection before changing data.'
    if ([85, 86].includes(code)) return 'MongoDB connected, but index initialization found an incompatible existing index. Review existing index definitions; no index was deleted.'
    return 'MongoDB connected, but database initialization failed. Check database permissions and existing index definitions.'
  }
  if (error?.name === 'MongoParseError') return 'MONGODB_URI is not a valid MongoDB connection string. Check its format and URL-encoded credentials.'
  return 'MongoDB connection failed. Check MONGODB_URI, network connectivity, database availability and Atlas network access rules.'
}
