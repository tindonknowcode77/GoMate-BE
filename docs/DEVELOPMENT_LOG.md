# Development log

## 2026-10-19 - Publish verified business events into the app and support multi-browser demos

### Summary

- Allow Staff/Admin to review business applications. Extend posts with validated event data, discount percentage and offer/terms; revalidate schedules at approval and publish one linked activity with server-derived business identity and an official schedule.
- Expose safe business offer metadata in discovery/details and retain ordinary request/approval/chat/attendance/rating authorization. Reject host-added friends and anonymous companion changes for business events; consumer publishing still cannot impersonate businesses.
- Add an explicit production-guarded workshop demo seed with five ordinary-login accounts, a personal sample and a staff-approved business sample. Preserve existing non-demo accounts and demo memberships on reruns.

### Files changed

- `src/modules/{portal,activities}/{routes,repository}.js`, activity validation/presentation, `src/database/{workshop-demo,seed-workshop-demo}.js`, `package.json`.
- `tests/{business-events,portal}.test.js`, `docs/PORTAL_API.md`, `README.md`; paired frontend portal/demo/UI is on GoMate-FE `fe-ui2`.

### Verification

- `npm test`: 103/103 passed. Business test covers repeat seed IDs, publication visibility, verified metadata, spoof prevention, membership restrictions, joining/chat and completed attendance/rating.
- Paired FE business browser integration passed the complete application/moderation/publication/discovery/join/chat flow across independent sessions. Existing web smoke, lifecycle, trip/media/Excel, community, maps and service integration suites passed.
- Reinstalled dependencies from lockfile to restore missing Leaflet assets; full map smoke now passes. Repeated seed against local configured MongoDB preserved sample IDs. Restarted API; actual Chrome/Edge demo logins and discovery passed. `git diff --check`: Passed.

### Remaining work

- Offers/prices do not process payments. Legacy announcements without event details remain portal-only. Workshop demo seeding must not be run against production data.

## 2026-10-16 - Allow immediate Admin role assignment

### Summary
- Removed target email verification prerequisite from role API and role editor at the user's request. Self-role protection and session revocation remain. Assignment does not mark email as verified or change login verification.

### Files changed
- BE portal/repository.js, tests/portal.test.js, docs/PORTAL_API.md; FE ConnectedPortal.jsx and docs/DECISIONS.md.

### Verification
- Backend portal tests: 7/7 passed, including assignment to an unverified account without changing email_verified.

### Remaining work
- None.


## 2026-10-16 - Admin user role management

### Summary
- Added Admin-only PATCH /api/portal/users/:id/role for user, staff and admin. Requires verified email, blocks self changes, records actor/time and increments credential version atomically to revoke previous sessions.
- Added role editor and save feedback to Admin user cards, separate from subscription changes. Business access still derives from approved applications and is explained in the UI.

### Files changed
- BE portal routes/repository, portal tests, Postman collection and PORTAL_API.md.
- FE ConnectedPortal.jsx and portal.web.cjs.

### Verification
- Backend portal tests: 7/7 passed using temporary MongoDB, including authorization, validation, self protection, session revocation and business effective roles.
- Browser portal workflow: passed, including UI role assignment and old session rejection.
- FE typecheck, final lint and web build passed; Expo Doctor 21/21 passed.

### Remaining work
- None within role assignment scope. Business approval remains a separate workflow.


## 2026-10-16 - Fix Atlas DNS startup failure

### Summary

- Diagnosed ECONNREFUSED during querySrv/queryTxt: Node's default resolver pointed to an unavailable loopback DNS service. After user authorization, DNS lookup and MongoDB ping succeeded using the Windows-configured resolvers.
- Added optional MONGODB_DNS_SERVERS with IP validation and applied it to the Node process before creating the MongoDB client. Set the local ignored .env override to the authorized Windows DNS addresses; system DNS and database credentials were not changed.
- Replaced the generic startup error with sanitized diagnostics distinguishing DNS, credentials, permissions and index initialization. No raw connection string or driver message is logged.

### Files changed

- src/config/env.js, src/database/mongo.js, src/database/startup-error.js, src/server.js, .env.example, tests/database-startup-error.test.js; local ignored .env.

### Verification

- node --test tests/database-startup-error.test.js tests/app.test.js: 7 tests passed.
- Real configured database: connection, ping and initializeDatabase all passed with the new configuration. No records or indexes were deleted.

### Remaining work

- Restart the backend process to load the updated environment. The DNS override affects DNS queries in this Node process only; leave it empty on hosts whose default resolver works.

## 2026-10-16 - Persist and authorize the Business, Staff and Admin portal

### Summary

- Add authenticated /api/portal endpoints and MongoDB collections/indexes for business applications/documents, moderated announcements and support tickets. Reuse community report handling and shared auth sessions.
- Enforce business ownership, private admin-only document downloads, atomic pending-only review decisions, bounded input and write limits. Only admins assign subscription entitlements; premium publishing requires an active Plus plan.
- Add an operator-only role assignment CLI that requires a verified account and revokes existing sessions. No default privileged account is created.
- Extend the existing Postman collection with 17 portal requests and document local startup, roles and contracts.

### Files changed

- src/modules/portal/*, src/database/mongo.js, src/database/set-portal-role.js, src/modules/auth/repository.js, src/app.js.
- tests/portal.test.js, package.json, postman/GoMate-Auth.postman_collection.json, docs/PORTAL_API.md.

### Verification

- Portal integration tests: 6 passed using isolated MongoDB 8.3.1.
- Initial full suite found a missing local leaflet package; dependency synchronization fixed it, and all 7 tests in the affected suite passed.
- node --test --test-concurrency=2: passed, 99/99 tests with system mongod 8.3.1 in isolated temporary databases.
- Portal browser integration: passed; Postman JSON parses and includes 17 portal requests. git diff --check passed.

### Remaining work

- Production setup uses existing MongoDB/email configuration and explicit provisioning of a verified administrator. Billing is entitlement-only; no charges or invoices.
- Documents are private MongoDB records with a 10 MB file limit. Report listing reuses the existing 200-record moderation queue. Business posts are announcements separate from activity scheduling.

## 2026-10-16 - Private activity drafts, member portraits and requested demo friends

### Summary

- Add authenticated one-draft-per-account storage with incomplete field validation, optimistic versions, bounded/rate-limited payloads and GridFS for photos/Excel beyond BSON limits. Clean old/rejected files on normal replacement/delete paths.
- Enrich owned/joined activities with up to four current approved-member profile avatars, excluding pending users and private companion names. Frontend uses neutral silhouettes instead of repeated sample portraits.
- Add/run an idempotent targeted demo-friend seeder: five separate full profiles/portraits and accepted friendships for the requested existing account. Preserve credentials/unrelated accounts on re-run.

### Files changed

- `src/modules/drafts/{repository,routes}.js`, `src/modules/auth/repository.js`, `src/app.js`, `src/database/mongo.js`.
- `src/modules/activities/{repository,validation}.js`, `src/database/seed-user-friends.js`, `package.json`, `tests/drafts.test.js`, `docs/activity-drafts.md`.

### Verification

- Full `npm test`: 93 passed. Final draft suite passed private partial drafts, >16 MB media/state round trip, conflicts, cleanup, seed idempotence and current approved-avatar refresh/privacy.
- Real configured DB: five profiles, five accepted friendships, five different portrait URLs; all portrait HEAD requests returned 200.
- FE trip/Maps integrations passed account draft reload/publication cleanup, companion typing, chat/media and member-photo UI; frontend typecheck/lint/doctor and web/native exports passed.

### Remaining work

- Production reconciliation for GridFS files orphaned by process termination; physical-device validation. Draft creation currently supports one explicitly saved unfinished post per account.

## 2026-10-16 - VIETMAP address/POI lookup alongside Mapbox

### Summary

- Prefer server-side VIETMAP Autocomplete v4 (`display_type=1`, optional lat/lng focus) and Place v4 for addresses/POIs. Preserve Mapbox GL JS, Directions and existing API contracts; use Mapbox permanent geocoding only if VIETMAP is not configured.
- Cache opaque provider references behind one-time UUID selections bound to the account/session. Validate points, map current city/ward components, retain selections on upstream failures and block duplicate in-flight selections.
- Configure the supplied key in ignored local `.env`. Public config exposes provider identity/availability, never the VIETMAP key. Keep fixed upstream URLs, rate/time limits and sanitized errors; do not silently fall back after VIETMAP denial.

### Files changed

- `src/config/env.js`, `src/modules/maps/{routes,service}.js`, `.env.example`, `tests/vietmap.test.js`, `docs/maps.md`, README.
- Ignored local `.env`: VIETMAP Services key added; existing values preserved.

### Verification

- `npm test`: 91 tests passed. Maps tests cover hybrid selection, API-key secrecy, account/session binding, exact opaque ref_id, retry after quota/point errors, timeout/rate handling and VIETMAP without Mapbox.
- Real VIETMAP Autocomplete/Place v4 returned 200. FE opt-in live script passed actual lookup with public-config secrecy and real Mapbox route/SDK rendering.
- FE hybrid UI/persistence and FE/BE service integration passed; typecheck/lint/doctor and web/native exports passed.

### Remaining work

- Physical-device and deployment verification; monitor VIETMAP/Mapbox quotas independently. Selection cache is process-local and expires after five minutes.

## 2026-10-16 - Mapbox provider migration and live map/API verification

### Summary

- Replace the preceding uncommitted Google integration with Mapbox GL JS 3.33.0/streets-v12 and fixed authenticated Geocoding v6/Directions v5 endpoints. Retain OSM for unconfigured installs, shared iframe/WebView bridge, circle radius, draggable/clickable pins and buffered polyline5 overlays.
- Persistable address selections use permanent geocoding; bound the selection cache to 500 entries/five minutes and the requesting account/session. Consume details without extra upstream calls. Validate requests/provider data, enforce rate/time limits and return sanitized errors.
- Configure the supplied public token only in ignored `.env`; accept public tokens for the SDK, do not expose secret tokens, remove old Maps configuration, preserve OAuth. Scope Mapbox CSP to the map document and keep provider logo/attribution.

### Files changed

- `src/config/env.js`, `src/app.js`, `src/modules/maps/{routes,service}.js`, `src/map/mapbox-map.{html,js}`, `.env.example`, `tests/maps.test.js`, `docs/maps.md`, README.
- Local `.env` updated without changing existing values; ignored, not staged. Previous uncommitted Google map documents replaced.

### Verification

- `npm test`: full suite passed 88 tests. Final `node --test tests/maps.test.js`: 3 passed after malformed upstream/body handling and explicit OSM fallback checks.
- Supplied token live: style, permanent Geocoding and Directions returned 200. FE opt-in live script passed real SDK/tiles, radius, pin, routes and attribution; no token output.
- FE Maps UI and trip regressions plus FE/BE service integration passed with temporary MongoDB; activity/chat points survive publication and reads. FE typecheck/lint/doctor and web/native bundle exports passed.

### Remaining work

- Physical-device WebView/GPS, deployed token/domain configuration and production budgets. Search uses persistable addresses, not temporary POI Search Box results. Cache is per process; expired/cross-instance selections require another search.

## 2026-10-16 - Google Maps configuration and authorized Places/Routes proxy

### Summary

- Add public browser-map configuration and authenticated, validated Places API (New)/Routes endpoints. Restrict provider URLs/fields, session/body formats, Vietnam autocomplete, modes, timeouts and per-account rates; sanitize upstream errors and keep server credentials private.
- Serve Google Maps JavaScript with Advanced Markers/circles/polyline bridge and scoped CSP when configured; retain OSM without a browser key. Keep attribution and frame-origin restrictions.
- Add blank env example and setup/API documentation. Do not write Google search lists/routes to MongoDB or change user billing/key/OAuth configuration.

### Files changed

- New `src/modules/maps/{service,routes}.js`, `src/map/google-map.{html,js}`, `tests/maps.test.js`, `.env.example`, `docs/maps.md`.
- `src/app.js`, `src/config/env.js`, README and this log; corresponding FE picker/map/route/chat integration and browser tests.

### Verification

- Full `npm test`: 88 passed. Focused Maps HTTP/provider tests passed after payload hardening; cover auth, body validation, fixed/minimal requests, key privacy, missing configuration, provider denial/timeouts/rate limits and map framing.
- FE `test:maps:web` passed using real FE/BE/MongoDB with a Google SDK/fetch double. Existing web smoke, trip and integration tests passed with unconfigured Google/OSM fallback.
- FE typecheck/lint, Expo Doctor 21/21 and web/Android/iOS bundle exports passed.
- `git diff --check`: passed. Local configuration presence only was inspected; neither key was printed or changed.

### Remaining work

- Both Google Maps key values are currently absent. Live billing/API/referrer/outbound-IP setup and physical-device verification are still required; provider doubles do not validate these.
- Application rate limits are per instance, not a shared spending cap. Configure provider quotas/alerts, production Terms/Privacy and Google data-retention/attribution requirements before wider deployment.

## 2026-10-15 - Authorized chat attachments, shared library and companion profiles

### Summary

- Accept bounded multipart uploads, identify supported file headers, and persist private Binary documents separately from message metadata. Expire unsent files; require current conversation access for every read and upload; support HTTP byte ranges for playback.
- Extend idempotent messages with owned conversation attachments, validated location snapshots and safe extracted links. Add a cursor-paged media/file/link/location library and meaningful notifications for content-only messages.
- Validate private companion names/notes against reserved seats. Add group-only reads, host/version-checked edits and atomic removal of consumed entries when real friends take reserved places. Keep companions out of public activity data and authenticated identities.
- Read host avatars from current profiles for Match/detail, with a legacy avatar-version fallback. Permit blob media in the SPA CSP for authenticated browser previews.

### Files changed

- `src/modules/chat/{content,routes,repository}.js`, activity routes/validation/repository, `src/common/companions.js`, database indexes and app CSP.
- `tests/chat-content.test.js`, `docs/chat-content.md` and this log; corresponding FE composer/library/viewer and companion interfaces.

### Verification

- Full `npm test`: 86 passed. New tests cover pending/sent file privacy, body/file limits, ownership, cross-room rejection, idempotency, snapshot validation, library cursors, byte ranges, revocation, private/versioned companions and seat conversion.
- FE integration and two-account trip browser tests passed against temporary databases; existing web smoke/community flows passed. No live users/files/provider configuration were changed.
- FE typecheck/lint, Expo Doctor 21/21, native-session tests and web/Android/iOS exports passed.
- `git diff --check`: passed.

### Remaining work

- MongoDB media limits and non-transactional upload-budget checks are documented in `docs/chat-content.md`. Migrate to private object storage with thumbnail/transcoding/retention/scanning jobs before increasing traffic or capacity.
- No physical-device camera/GPS/playback QA, voice recording/calls, live location, OS push or durable offline message queue yet. Google provider setup and the separate business website remain deferred.

## 2026-10-15 - Daily account APIs, notifications, reviews, blocking and reporting

### Summary

- Add authenticated account-scoped settings, paged notification/read-state, block list, report/history, rating form/submission and admin moderation endpoints.
- Wire real friend/activity/chat events to deduplicated notification records; align chat read markers with message notifications and preserve primary writes if notification storage fails.
- Enforce direct-message preferences on both creation and sending, bilateral blocks on direct access/search/invitations/discovery/join and actual attendance/target identity for completed activity ratings.
- Add unique/idempotency indexes, safe public projections, real reputation/count queries and version-independent retryable moderation decisions. Client registration/settings cannot grant admin privileges.

### Files changed

- New `src/modules/community/{repository,routes}.js`, `tests/community.test.js`, `docs/community.md`.
- `src/{app.js,database/mongo.js}`, activity/auth/chat/profile repositories/routes, README and this log.

### Verification

- Full `npm test`: 81 passed. Final focused activity/community/trip tests: 18 passed after event hooks.
- FE integration, two-account community/trip browser tests and full web smoke passed against temporary databases, without production messages/accounts.
- FE typecheck/lint/Expo Doctor (21/21), native session regression and all-platform bundles passed.
- `git diff --check`: passed.

### Remaining work

- OS push/device registration and scheduled notification jobs are not provisioned. Notifications are secondary writes, not a durable outbox; failed notification storage is logged without undoing the primary action.
- Moderation is an admin-only API; live admin provisioning/operator UI and staffing are separate. No live role was changed.
- Business website, identity verification and payments remain separate; Google provider setup stays deferred as requested.

## 2026-10-15 - Consumer publishing policy, schedule confirmation and inbox summaries

### Summary

- Reject business activity creation/conversion through consumer endpoints; preserve business discovery records.
- Expand accepted categories to match the 56 FE options.
- Add host-only versioned/idempotent schedule confirmation with audit history; clear it when time or meeting location changes.
- Return actual avatar, group host/count/state and confirmation metadata; order inbox by newest message before pagination.

### Files changed

- `src/modules/activities/routes.js`, `validation.js`, `src/modules/chat/repository.js`.
- `tests/match-preferences.test.js`, `tests/trip-social.test.js`, `docs/activity-management.md`, README and this log.

### Verification

- `npm test`: 75 tests passed with isolated MongoDB, including business denial, confirmation permission/version/reset checks, early chat and newest-message ordering.
- FE service integration, full browser smoke and two-session trip/chat UI tests passed against BE. No production records are used by these tests.
- `git diff --check`: passed.

### Remaining work

- Separate business website publishing service is outside the consumer endpoint; consumer web clients also cannot publish business activities.

## 2026-10-15 - Trip planning, reserved seats, age preferences and social chat

### Summary

- Add structured itinerary, safe HTTPS plan links, bounded original Excel attachments
  with authorized downloads, host-only versioned editing and private byte projections.
- Add optional structured address/cost fields, offline companion reservations,
  accepted-friend initial membership and atomic host additions/seat conversion.
- Add age preference validation/enforcement and age-range discovery; retain legacy
  preference/text-plan compatibility. Revalidate plans when activity dates change.
- Add friend pair indexes, public name/Nickname search, idempotent requests,
  recipient-only decisions and own-relationship removal. Extend authorized chat
  summaries/deep-link reads and derive sender names on BE.

### Files changed

- `src/common/{activity-plan,preferences,match-filters}.js`
- `src/modules/activities/{routes,repository,validation}.js`
- `src/modules/auth/repository.js`, `src/modules/friends/routes.js`
- `src/modules/chat/{routes,repository}.js`, `src/database/mongo.js`, `src/app.js`
- `tests/trip-social.test.js`, `docs/trip-social.md`, `README.md`

### Verification

- `npm test`: Passed, 74 tests.
- Focused trip/social and chat tests: Passed, 7 tests before the full suite.
- FE integration and existing web smoke: Passed against real API/MongoDB.
- New two-account browser flow: Passed friendship acceptance, full creation,
  shared chat persistence, capacity/seat conversion, host-only plans and Excel download.
- Syntax checks and `git diff --check`: Passed.

### Remaining work

- Excel is retained/downloaded as a bounded attachment, not parsed into itinerary rows.
- Native device and third-party document application review is not performed.
- Product/data decisions are recorded in the FE `docs/DECISIONS.md`.

## 2026-10-15 - Match discovery preferences, favorites, covers and maps

### Summary

- Add declared personal/business activity types with legacy personal defaults,
  explicit recommendation/nearest/soonest sorting, and bounded preference-based
  ranking before pagination. Keep existing geospatial distance queries and require
  location for nearest/radius; retain estimated-cost filters without deposit filters.
- Save account-specific filters, category feedback and up to 500 favorite IDs.
  Validate saved values/ranges and exclude precise GPS from persisted filters.
  Derive feedback categories from actual activity records; omit deleted favorites.
- Add version-guarded cover upload/removal with image validation and cleanup,
  and expose only the public Google web client ID for FE sign-in configuration.
- Serve Leaflet locally with an OSM tile map and frontend-origin frame policy;
  no credentials are embedded in map URLs or sent to the tile provider.

### Files changed

- `src/modules/activities/{validation,routes,repository,me-routes}.js`
- `src/modules/auth/{repository,routes}.js`, `src/modules/profile/routes.js`
- `src/common/match-filters.js`, `src/map/*`, `src/app.js`
- `package.json`, `package-lock.json`, `tests/match-preferences.test.js`
- `docs/match.md`, `README.md`

### Verification

- `npm test`: Passed, 68 tests.
- `node --test tests/match-preferences.test.js`: Passed, 7 tests; rerun after final
  filter/nearest validation and map-CSP updates. Uses isolated MongoDB and image storage.
- FE integration: Passed against real BE services.
- Browser smoke passed Match/GPS/map/media, favorites join/cancel, restored-radius
  location prompts and simulated Google callback flows without runtime errors.
- `git diff --check`: Passed.

### Remaining work

- Google provider configuration is deferred; no real provider account was used.
- Native device/GPS review and production tile-provider capacity are not validated.
- Architecture/product choices are recorded in the FE `docs/DECISIONS.md`.

## 2026-10-13 - Remote demo images, complete member accounts and real group rosters

- Added curated external Unsplash activity photos and Random User avatars/Unsplash
  covers. Ten complete member accounts bring demo total to 14. Enriched only marked
  demo records; kept existing credentials, dates and roster decisions intact.
- Seeded 59 approved memberships and 20 pending requests across 20 groups (3–5
  people including host); version guards prevent reintroducing departed members.
- Added authenticated public-profile read with private fields omitted and member
  avatar responses. Narrow CSP permits the two selected external media providers.
- Verification: 57 BE tests passed; FE integration/typecheck/lint/Expo Doctor and
  export passed. Remote URLs and browser profile/group images verified; actual DB
  counts, completion and membership totals audited without exposing credentials.
- Sources and account instructions: docs/demo.md and database/demo-media.js.
- Remaining: external image availability and physical-device QA.

## 2026-10-13 - Signup sessions, exact activity filters, profiles and TP.HCM demo

- Set password creation/reset/change minimum to six without composition rules;
  successful verification returns a live Bearer session. Tested expiry, revocation,
  verification replay and short-password registration.
- Added min/max activity size and validated optional participant requirements.
  Discovery matches Vietnam date ranges, minute ranges, group size and preferences;
  join requests check volunteered profile fields and activity version.
- Extended profile writes with languages and optional personal fields; responses
  derive completion/missing fields. Account-owner permission and avatar handling preserved.
- Added insert-only demo seeder: 20 fictional future TP.HCM activities, four demo
  users; ran it against configured database without replacing previous rows.
- Files: auth/profile/activity modules, common/preferences, database demo scripts,
  package script, tests, docs and Postman metadata.
- Verification: npm test 57/57 passed; FE real-service integration, typecheck/lint,
  Expo Doctor 21/21 and web export passed. Browser profile save, creation, precise
  filtering and demo reminder checked; test activity removed afterward.
- Remaining: financial transaction processing and broader UI integrations are outside
  this task. Demo schedules remain fixed after first seed; records clearly marked demo.

## 2026-10-13 - Activity lifecycle, attendance and updates

- Added host-only start/complete transitions, attendance marking and notes;
  host/approved members can read paginated attendance and chronological updates.
  Start snapshots host/approved roster, initializes unmarked attendance and records
  actual time. Host may start early/late; complete freezes attendance/notes.
- Status/attendance changes and audit entries share atomic version-checked writes.
  Repeated identical attendance marks do not add logs; stale writes return 409.
  Bound note/attendance log growth while reserving ability to complete.
- Preserve member detail access after start/completion; block normal edits after
  early start. Existing membership/chat/personal lists continue to work.
- Files: activity routes/repository/validation, new lifecycle integration test,
  lifecycle/activity docs, Postman collection and guide (49 requests).
- Verification: full backend suite 51/51 passed using isolated MongoDB 8.3.1 and
  `npm.cmd test -- --test-concurrency=1` with installed MONGOMS_SYSTEM_BINARY.
  Covers concurrent starts, permissions, roster, audit consistency, stale writes,
  completion locking, chat access and personal-list integration. Postman JSON and
  scripts validated. No live database touched.
- Remaining: FE wiring; no automatic lifecycle scheduler, self-check-in, push,
  location/time changes during progress or reopening completed activities.

## 2026-10-13 - Password recovery and authenticated password change

- Added forgot/reset/change-password endpoints, separate SMTP reset template,
  hashed six-digit reset codes, ten-minute expiry, five attempts, 60-second resend
  cooldown and endpoint rate limits. Forgot uses a generic response for unknown,
  ineligible/cooldown accounts and SMTP delivery failure; missing config is 503.
- Atomic credential-version increment revokes all prior sessions on reset/change,
  including delayed login sessions issued from stale credentials. Legacy sessions
  default to version 0. Changes clear pending reset codes; Google-only users do
  not receive local-password resets. Sensitive reset state excluded from profile
  and session repository projections.
- Files: auth routes/repository/email, authenticate middleware, recovery and email
  tests, password-recovery docs, README, Postman collection/guide.
- Verification: full backend suite 50/50 passed on isolated MongoDB 8.3.1 using
  `npm.cmd test -- --test-concurrency=1` with installed MONGOMS_SYSTEM_BINARY.
  Covers concurrent reset consumption, expiry/attempts, wrong/old passwords,
  stale-session creation, all-session revocation and SMTP failure rollback.
  Postman JSON/scripts validated (43 requests). No real email sent or .env read.
- Remaining: FE integration and live SMTP delivery verification by the user.

## 2026-10-13 - Direct/group chat and SSE updates

- Added persistent conversations, paginated text messages, idempotent sends using
  clientMessageId, per-user monotonic read markers and unread counts. Unique indexes
  enforce one direct conversation per pair and one group conversation per activity.
- Group authorization uses live approved membership/host ownership. Deleted
  activities and removed members cannot access chat. SSE provides per-conversation
  snapshots on connect/change, with session/membership rechecks, heartbeat,
  connection limits, slow-client cleanup and a five-minute reconnect boundary.
- Architecture choice: poll shared MongoDB once per second per stream rather than
  require Redis, replica sets or change streams. Snapshot invalidation is not a
  durable event log; clients refetch/merge messages and reconnect explicitly.
- Files: new `src/modules/chat/{repository,routes}.js`, server/app wiring, database
  indexes, `tests/chat.test.js`, `docs/chat.md`, README and Postman files.
- Verification: full backend suite 49/49 passed on isolated MongoDB 8.3.1 via
  `npm.cmd test -- --test-concurrency=1` with MONGOMS_SYSTEM_BINARY and MONGOMS_VERSION.
  Includes concurrent creation/send deduplication, history paging, read monotonicity,
  cross-user isolation, SSE messages/read updates, removal/session revocation and
  activity deletion. Syntax checks passed; Postman JSON/scripts valid (40 requests).
- Remaining: FE wiring; attachments, typing/presence, push notifications and user
  blocking are not implemented. Conversation list orders by creation time; refresh
  it on app focus for new conversations. Polling cost grows with active streams.

## 2026-10-13 - Group membership list, leave and removal

- Added paginated GET `/api/activities/:id/members` for host/approved members,
  DELETE `/members/me` for self-leave and DELETE `/members/:userId` for host removal.
  Host cannot leave/be removed; writes require an upcoming published activity.
- Atomically transition approved to left/removed with memberCount decrement and
  version increment. Concurrent leave/removal cannot decrement twice. New states
  support request filtering and reapplication (requires approval again).
- Added Group Members Postman folder and memberUserId auto-capture on member login;
  documented visibility, snapshot names, resubmission and lifecycle restrictions.
- Files: activity routes/repository/me-routes, join-requests integration test,
  activity API docs, Postman collection and guide.
- Verification: focused integration tests passed on local isolated MongoDB 8.3.1;
  full backend suite passed 48/48 using `npm.cmd test -- --test-concurrency=1`
  with MONGOMS_SYSTEM_BINARY pointing to installed mongod and MONGOMS_VERSION=8.3.1.
  Includes permission checks, concurrent leave/removal, count consistency,
  resubmission, personal list updates, started/deleted activities. Postman JSON
  and scripts validated (33 requests). Earlier MongoDB-blocked tests now pass.
- Remaining: FE wiring; member names are snapshots, not live profile lookups.

## 2026-10-13 - Personal activities and join requests

- Added authenticated GET `/api/me/activities` for approved participation and
  GET `/api/me/join-requests` with optional pending/approved/rejected/cancelled
  filter. Both paginate with stable ordering and derive identity from the token.
- Exclude hosted/deleted activities and sanitize activity output. Request lists
  expose only the caller's request. Include past activities; no automatic request
  expiry or activity lifecycle inference. Added a multikey participant index,
  created on startup/migration, and a My Participation Postman folder.
- Files: activity `me-routes.js` and `repository.js`, `src/app.js`, database
  `mongo.js`, tests `me-activities.test.js` and `join-requests.test.js`, activity
  docs, Postman collection and guide.
- Verification: new HTTP route test passed with stub repositories (identity,
  authentication, query validation, paging and no-store). Syntax checks passed;
  Postman JSON and scripts validated (29 requests). Existing full suite run:
  12 passed, 5 integration suites failed at temporary MongoDB startup with
  fassert, including retry outside sandbox. Expanded real-database assertions
  for isolation, state filters, paging and soft deletion remain unverified.
- Remaining: run MongoDB integration tests in a working environment; FE wiring.

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
