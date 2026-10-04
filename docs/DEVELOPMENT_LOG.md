# Development log

## 2026-10-04 - Activity discovery API

- Added authenticated `/api/activities`, validated keyword/category/cost/time/
  distance filters and offset pagination. Use MongoDB geoNear/2dsphere for
  distance and stable startsAt/id sorting; only future published non-full
  activities by other hosts are discoverable. Added repository/server wiring.
- Added activities integration tests, `docs/activities.md` schema/contract and
  a Postman search request. No sample data inserted into the app database.
- Verification: 40/40 backend tests passed with isolated MongoDB 8.3, including
  real geospatial queries, literal search, combined filters and malformed input.
- Remaining: activity creation/editing, join approval, production data and
  device GPS verification. Search currently uses case-insensitive literal
  matching, not accent-insensitive/fuzzy search.

## 2026-10-04 - Cloudinary avatars and local file uploads

- Added signed backend Cloudinary uploads, multipart `avatar` files and existing
  JSON-base64 compatibility. Re-encode images before upload; persist HTTPS URL
  and public ID instead of binary. Keep legacy MongoDB images readable.
- Added Cloudinary config and blank local `.env` entries (no secrets supplied),
  SDK/storage adapter, Multer limits and Cloudinary image CSP. Clean up replaced
  assets after DB success; attempt rollback cleanup on failed DB writes.
- Updated Postman to select a local file directly and view absolute avatar URLs;
  documented configuration in `docs/profile.md` and `postman/README.md`.
- Verification: 35/35 backend tests passed with isolated MongoDB 8.3 and fake
  Cloudinary SDK/provider; includes multipart, validation, replacement and cloud
  failure preservation. No real Cloudinary upload: credentials are missing.
- Remaining: fill backend Cloudinary credentials, restart and test a real local
  image. Cleanup failures are logged but do not yet have a durable retry queue.

## 2026-10-04 - Update Postman for sessions and profiles

- Updated the existing collection to 12 requests, adding own-profile GET/PATCH,
  avatar PUT and public image GET before logout. Login/Google now send boolean
  `rememberMe`; scripts capture token, expiry, user ID and avatar URL.
- Added `postman/README.md` with import instructions, manual request order,
  variable usage and local image-to-base64 instructions. No live requests sent
  and no credentials copied from environment files.
- Verification: parsed JSON, checked substituted request bodies/variables and
  JavaScript syntax of collection scripts; `git diff --check` passed.
- Remaining: import the updated local collection into Postman; no direct
  Postman workspace synchronization or authenticated server run performed.

## 2026-10-04 - Profile and avatar API

- Added authenticated GET/PATCH own-profile and PUT avatar, plus public avatar
  image GET. Validates field types/lengths, unique normalized usernames and owner
  identity; avatar input is limited, decoded and re-encoded by Sharp.
- Store small avatar binaries in MongoDB user records with versioned URLs,
  excluding image data from regular authentication/profile queries. Added a
  partial unique username index; existing accounts need no backfill.
- Changed `src/app.js`, auth repository, database indexes, package/lockfile;
  added `src/modules/profile/routes.js`, `tests/profile.test.js`, `docs/profile.md`.
- Verification: 32/32 tests passed with installed MongoDB 8.3 in isolated
  temporary databases; `git diff --check` passed. Coverage includes owner-only
  writes, forbidden fields, duplicate usernames, avatar persistence/replacement,
  valid WebP output and oversized/corrupt/SVG rejection.
- Remaining: avatar deletion, public member-profile API and device-level UI QA.
  No deployment or live application database modification was performed.

## 2026-10-04 - Persistent login backend support

- Added optional boolean `rememberMe` to password and Google login, using
  `REMEMBER_SESSION_TTL_HOURS` (default 720) while preserving the normal session
  lifetime. Extended login and `/auth/me` responses with expiration metadata.
- Added stable 401 codes for missing authorization and invalid/expired sessions.
  Retained MongoDB token hashes, fixed expiration, no-store responses and
  per-session logout. No refresh token or sliding renewal was introduced.
- Changed auth routes/repository/middleware, config, HttpError/error response,
  auth integration tests, README and auth documentation. Added
  `docs/persistent-login.md` with the FE integration contract.
- Verification: 26/26 tests passed with `npm.cmd test`, using the installed
  MongoDB 8.3 binary via `MONGOMS_SYSTEM_BINARY` and
  `MONGOMS_SYSTEM_BINARY_VERSION_CHECK=false`. Tests used an isolated temporary
  database, not application data. Initial sandbox test could not access the
  binary cache; the subsequent default download was stopped in favor of the
  installed binary. `git diff --check` passed.
- Remaining: FE must send `rememberMe`, securely persist the token, call `/me`
  on startup and clear local credentials on 401/logout. No deployment or live
  device test performed. User's pre-existing `.env.example` deletion preserved.
