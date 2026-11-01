# Business web API

All endpoints below use `/api/portal`, require a GoMate bearer token and enforce permissions on the server. Clients must send the latest integer `version` on updates, reviews and withdrawals; stale writes return 409. Legacy applications/posts without a stored version are exposed as version 0. Lists use `?page=1`, with 20 items per page.

## Registration and review

- `GET /me`: effective portal role and the owner's persisted application, excluding document bytes.
- `POST /applications`: company, category, taxId (10/13 digits), address, representativeName, representativeTitle, representativeEmail, representativePhone, optional website and license `document: {name,mime,base64}` (PDF/PNG/JPEG, maximum 10 MB). A rejected application can be corrected and resubmitted with its version; the existing license can be reused.
- `GET /applications`: admin review queue.
- `GET /applications/:id/document`: owner or platform reviewer only.
- `PATCH /applications/:id`: admin, `{version,status:approved|rejected,reviewNote}`. Rejection requires a reason. Pending applications and approved businesses reserve their tax ID. Verification is a human document review, not a government tax-registry integration.

## Locations and campaigns

Verified owners manage `GET/POST /locations`, `PUT/DELETE /locations/:id`. Locations contain name, address, city, phone, latitude, longitude and optional mapX/mapY. Employees can read saved locations belonging to the verified businesses that assigned them; itinerary writes still validate the group owner. Locations referenced by pending campaigns cannot be deleted.

Owners use `GET/POST /posts`, `PUT /posts/:id` to correct pending/rejected posts and `DELETE /posts/:id` to withdraw them. Post fields: title, copy, badge, discount, border (Glow/Soft/Solid), premium, discountPercent, offer, offerTerms and either a legacy event or 1–20 groups. Each group has name, optional locationId, depositAmount and event. Event fields follow activity validation, including dates, capacity, price and coordinates. Deposits cannot exceed the published price; premium styling requires an active Plus plan.

Admin review with `PATCH /posts/:id` (`version`, status, reviewNote). Each approved group becomes a real activity. Before approval, staged activities are private. Stable activity IDs and a publication lease prevent duplicate groups during retries; the server periodically reconciles approved publications after interruptions. Public `/feed` excludes reviewer notes and audit history.

## Business-created employee accounts and scoped authority

- Only verified business owners use GET/POST /staff and PUT/DELETE /staff/:id. New accounts require name (2–100 characters), a new email, password (6–128 characters), phone, title and groupIds (0–50 unique approved groups owned by that business).
- POST creates a separate active password account immediately. Passwords are hashed by the standard auth module and never returned or stored in grant/notification records. Existing emails return 409; this endpoint never changes another account's password or identity.
- Assignments use status approved and provisionedAt. There is no staff consent or admin review step. The staff-invitations and staff-requests APIs have been removed. Global staff moderation remains disabled; only admin reviews business applications/posts and handles platform administration.
- PUT requires the current version, keeps the employee email/user identity, and applies group changes immediately. DELETE revokes delegated access immediately. Updates can activate a legacy pending assignment explicitly; existing approved/consented assignments keep working without migration.
- The global account role stays user; the effective portal role is business-staff only while an active assignment belongs to a verified business. Group, app activity, member list and chat access remain limited to assigned groups. Employee assignments do not create participants, consume seats or grant global moderation.

## Real group operations

Owners and authorized employees use:

| Endpoint | Body / behavior |
| --- | --- |
| `GET /groups`, `GET /groups/:id` | Scoped real activity state, readiness, members, requests, receipts and attendance |
| `PUT /groups/:id/plan` | version, itinerary (at most 60 validated items); invalidates schedule confirmation |
| `PATCH /groups/:id/requests/:requestId` | version, approved/rejected status; capacity and lifecycle checks |
| `PATCH /groups/:id/deposits/:userId` | version, paid/pending status; approved members only |
| `POST /groups/:id/offers` | version, unique clientId, title, body, optional future expiresAt; deduplicated member notifications |
| `PUT /groups/:id/offers/:offerId` | version, title, body, expiresAt; update persisted offer and existing recipient notifications without duplicates |
| `POST /groups/:id/actions/confirm-schedule` | version; minimum participants, outside participant, deposits and valid schedule required |
| `POST /groups/:id/actions/start` | version; rechecks readiness and confirmed schedule; snapshots attendance |
| `PATCH /groups/:id/attendance/:userId` | version, unmarked/present/late/absent status; running groups only |
| `POST /groups/:id/actions/complete` | version; all attendance marked before manual completion |
| `GET /notifications` | Current user's business notifications |

Deposit receipts are a **manual ledger**, with canonical amount, recordedBy and timestamps. This does not collect payments, issue refunds or verify a bank transfer; no payment gateway is implemented. Unpaid required deposits also block starting through the ordinary activity API. Completed groups use the existing attendance-gated mobile rating and friendship flows.

Application/post/staff transitions keep actor/time history; group mutations use the existing activity event log. Browser tests use temporary databases and independent owner/admin/employee/participant sessions, never the configured application database.

Multiple accepted/admin-approved staff may manage the same group. Group views expose the approved managers, while member counts and attendance include only actual participants. Admin queue notifications accompany submission and recipient consent. Itinerary dates and saved location references survive editing; campaign activities use canonical saved-location GeoJSON coordinates.

## Wallet reconciliation

GET /wallet is restricted to verified business owners, scoped by authenticated owner ID, and served with Cache-Control: no-store. It returns VND manual receipt totals by group, a provisional 1000-basis-point fee rounded per approved participant, and estimated net proceeds. Pending/rejected members and invalid receipt amounts are excluded. availableBalance and verifiedHeldBalance remain zero. No collection, refund, dispute or payout endpoint is provided; activity completion does not release manual receipts. These figures are reconciliation estimates, not proof of held funds.

Approved, consented staff assignments also appear in GET /api/me/activities with a viewer-specific isBusinessManager flag. Assigned staff may read activity details (including completed groups), members, attendance and updates. Staff chat-list reads create any missing assigned-group conversation idempotently; prior approved assignments are supported without migration. Revoked assignments disappear immediately unless the user separately holds ordinary participant access. Staff are not added to joinRequests or participant capacity; delegated writes remain on the scoped portal endpoints.
