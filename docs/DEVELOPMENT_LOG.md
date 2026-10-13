# Development log

## 2026-10-13 - Organize Postman by feature

- Grouped collection into System, Authentication, Profile, Activities and Join
  Requests; split Join Requests into Setup, Member and Host subfolders.
  Updated the Postman guide with the folder structure.
- Files: `postman/GoMate-Auth.postman_collection.json`, `postman/README.md`.
- Verification: JSON parsed, all 26 request objects compared unchanged before
  and after regrouping, names remain unique and request scripts compile.
- Remaining: reimport the collection in Postman; no live API calls needed.

## 2026-10-13 - Postman join request workflow

- Updated collection with a Join Requests folder: separate host/member login,
  host activity creation, submit, list, cancel, approve and reject (8 requests).
  Separate role tokens prevent accidental host/member session switching;
  submit automatically saves the request ID. Added usage instructions.
- Files: `postman/GoMate-Auth.postman_collection.json`, `postman/README.md`.
- Verification: collection JSON parsed; all request scripts compile; 26 requests
  total. No live API calls or credentials used.
- Remaining: import into Postman and test with two verified accounts.

## 2026-10-13 - Activity join requests

- Added authenticated submit/cancel and host-only list/approve/reject endpoints.
  Validate body/query, paginate/filter host lists, reject duplicate requests,
  host self-joining, unavailable activities and capacity overflow.
- Store bounded requests inside the activity document (5,000 distinct applicants).
  MongoDB single-document atomic updates keep approval and memberCount consistent
  without requiring transactions/replica sets; all mutations increment version.
  Cancelled/rejected requests may be resubmitted with a new ID; prior attempts
  are replaced. Approved entries retain member identity. No schema migration needed.
- Files: `src/modules/activities/routes.js`, `repository.js`,
  `tests/join-requests.test.js`, `docs/activities.md`.
- Verification: syntax checks passed for all three JS files. Added integration
  coverage for permissions, cancellation/resubmission/rejection, validation,
  privacy, duplicate concurrent submissions and concurrent last-seat approvals.
  Full suite: 12 tests passed; 5 MongoDB integration suites blocked by environment.
  Initial binary download was blocked; using installed MongoDB 8.3.1 instead
  hit insufficient disk space (minimum 500 MiB), including a sequential retry.
  New integration test has not passed; rerun with sufficient disk space.
- Remaining: FE integration, joined activity/member APIs and request history.

## 2026-10-04 - Activity CRUD and host management

- Added create, owner list, detail, partial update and soft-delete endpoints.
  Derive host/status/member count server-side; validate dates, category, text,
  capacity, cost and GeoJSON. Reject non-host writes and edits after start.
- Added optional Cloudinary cover uploads with rollback/replacement cleanup,
  compare-and-update versions and owner-list index. Reused existing cloud adapter
  with separate activities folder. Added five Postman requests and API docs.
- Files: activity routes/repository/validation, app/database wiring, cloud adapter,
  `tests/activity-crud.test.js`, Postman collection, activity docs.
- Verification: backend suite 46/46 passed using isolated MongoDB 8.3 and mocked
  Cloudinary. Includes owner isolation, persisted search visibility, invalid dates,
  capacity, stale concurrent writes, upload rollback and deletion visibility.
- Remaining: participant requests/approval, joined lists, lifecycle beyond CRUD,
  durable cloud cleanup retries. No live account data or production deployment.

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
