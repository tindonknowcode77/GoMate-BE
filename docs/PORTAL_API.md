# Business, Business Staff and Admin portal

The web portal is available at `/portal` on the same server as the exported Expo app. It uses the existing email/password registration, email verification, password recovery and bearer-session APIs. Registration does not grant Admin privileges. A verified user can submit a business application; approval grants business access on the next request.

## Start locally

From `GoMate-FE` in PowerShell:

```powershell
$env:EXPO_PUBLIC_API_BASE_URL='/api'
npx.cmd expo export --platform web --output-dir dist --clear
```

Start the backend with `npm.cmd start` in `GoMate-BE`, then open `http://localhost:3000/portal`. MongoDB and email delivery use the existing BE configuration. Restart the backend after source changes. Database indexes are created on startup.

For the first administrator, register a real account and verify its email, then run this operator command in `GoMate-BE`:

```powershell
npm.cmd run portal:role -- your-verified-email@example.com admin
```

Replace the email with the intended operator account. This command also supports `user`; it revokes existing sessions. No administrator is seeded automatically. Demo accounts exist only after explicitly running `npm run db:seed-workshop`; they use ordinary password login and can be customized with WORKSHOP_DEMO_PASSWORD on first creation. The seed command is disabled under production NODE_ENV.

## Campaign creation, audience and lifecycle

- A saved branch is optional. Group events may contain a manual location, meetingPoint, province and address. Location-library coordinates may both be omitted; if supplied, both must be valid. Saving without coordinates removes previously saved geometry rather than substituting zero.
- The portal defaults to shared group information. Exact totals use quotient/remainder allocation (20 participants / 3 groups = 7, 7, 6), with an explicit uneven-split notice. New business groups start with zero participant seats occupied; the organizer is a manager. Existing approved groups are not recounted.
- Persist one consumer group per campaign in `business_audiences`, uniquely indexed by userId/postId. Existing pending/approved membership takes priority on initial allocation. Enforce this across search pagination, feed, favorites, participating lists, direct activity routes, joins and chat. Siblings return 404 on consumer activity routes. Owners/Admin/scoped staff retain management access. Withdrawing/deleting the allocated group does not expose another sibling.
- `POST /api/portal/posts/:id/lifecycle` requires an owning business or Admin and `{version, action: "withdraw" | "delete", groupId?}`. groupId is the published activity ID; omit it to act on the entire post. Individual group commands require a reviewed post. Staff cannot perform these actions. Stale versions/publication in progress return 409.
- Withdrawal hides discovery and cancels group writes; deletion is logical and hides the post/group while retaining receipts/history/audit. Approved members can retain read-only withdrawn-group history. Capture recipients before closing requests and notify affected pending/approved users. Private durable lifecycleTasks reconcile activity state, system chat and idempotent notifications after interruptions; they never appear in API responses. Publication repair processes these tasks without resurrecting withdrawn/deleted groups.
- Business owners and approved assigned staff use existing authenticated conversation/history/message/upload/download APIs in the website. Grant revocation removes staff access; cancelled groups are read-only. No separate chat store or endpoint is introduced.

## Routes

All routes below start with `/api/portal` and require `Authorization: Bearer <token>`. List routes use `?page=1` with pages of 20 items.

| Method | Route | Access / behavior |
| --- | --- | --- |
| GET | `/me` | Current identity, effective role, subscription, own application |
| POST | `/applications` | Verified user; submit/resubmit a rejected business application |
| GET | `/applications` | Admin; application list, without document contents |
| GET | `/applications/:id/document` | Admin; private attachment download |
| PATCH | `/applications/:id` | Admin; pending → approved/rejected, optional reviewNote |
| GET | `/posts` | Business: own posts; Admin: moderation list |
| POST | `/posts` | Approved business; creates a pending post |
| PATCH | `/posts/:id` | Admin; pending → approved/rejected |
| GET | `/feed` | Any authenticated user; approved business announcements only |
| GET | `/metrics` | Business: own counts; Admin: system counts |
| GET | `/users` | Admin; safe user fields and subscription |
| PATCH | `/users/:id/subscription` | Admin; plan free/plus, status active/paused/cancelled |
| GET | `/reports` | Admin; existing community report queue (up to 200 records) |
| PATCH | `/reports/:id` | Admin; resolved/dismissed and hideActivity boolean |
| GET | `/tickets` | Own tickets; Admin can see all |
| POST | `/tickets` | Any verified user; subject and message |
| POST | `/tickets/:id/replies` | Owner or Admin; message and status |

Applications accept `company`, `category`, optional `website`, and `document: {name, mime, base64}`. Documents are PDF/PNG/JPEG, up to 10 MB, with file-signature validation. They are stored privately in MongoDB and excluded from list responses. Downloads are attachments, never inline HTML. A rejected application can be resubmitted; concurrent or repeated decisions return 409.

Posts accept `title`, `copy`, `premium`, `badge`, `discount`, and `border` (Soft/Glow/Solid). Premium creation requires an active Plus plan on the server. Event posts additionally accept `discountPercent` (integer 0–100), `offer` (up to 200 characters), `offerTerms` (up to 500), and `event` with category, location, optional province/address/meetingPoint, startsAt/endsAt, optional registrationDeadline, estimatedCost, maxParticipants and optional itinerary/plan/planLink. The title and description derive from title/copy; clients cannot inject organizer identity, membership, verified status, guests or host IDs.

On admin approval, an event is published into `activities` using its stable `activityId`, server-owned business identity/verified flag, offer metadata and an official confirmed schedule. Pending/rejected posts never enter discovery. Schedule validation runs again at review time; expired appointments must be recreated. Upsert publication prevents duplicate activities on retry. Legacy posts without event details remain portal-only announcements; do not invent schedules for them.

Verified events use the ordinary join-request → organizer approval → group-chat → attendance → review flow. Consumer create/update cannot impersonate a business. Business events reject anonymous companion edits and host-added friends; the published event metadata is moderated, while the organizer can maintain the shared itinerary. Prices/discounts do not charge the user.

Subscriptions are administrative entitlements, **not payments**: no charge, invoice, payment provider, renewal job or revenue claim is made. Owners can request changes via support; only Admin changes entitlements. Existing approved posts keep their historical decoration if a plan is later paused.

Support threads are persisted, ownership checked, and limited to 100 messages per ticket. Owner replies reopen a ticket. Admin can close it with a reply. The portal exports real aggregate metrics as JSON.

## Verification

```powershell
node --test tests/portal.test.js tests/business-events.test.js
```

The tests use an isolated MongoDB memory-server database. For a locally installed mongod, set `MONGOMS_SYSTEM_BINARY` to its executable and `MONGOMS_VERSION` to its installed version. Run `npm run test:business:web` in `GoMate-FE` after exporting with `/api`; the browser test uses independent sessions to verify applications, approval/publication, discovery, offers, joins, chat and mobile layout. See `GoMate-FE/docs/DEMO_GUIDE.md` for manual Chrome/Edge demo steps.

The portal also reuses the configured Google sign-in button from the application. Google login requires the existing provider configuration; the browser tests exercise email/password login. Apple sign-in and native push notifications are outside this portal implementation. OAuth provider setup is not provisioned by these changes.

## Admin role assignment

PATCH `/api/portal/users/:id/role`, body `{ "role": "admin" }`. Allowed roles: user, admin. Admin authorization required; target email verification is not required. Role assignment does not verify the email. Self changes return 409; missing users return 404. Successful updates invalidate previous sessions through credential_version and record roleUpdatedBy/roleUpdatedAt. Business remains derived from an approved application; selecting user does not revoke an approved business application. GET /users includes email_verified and effectiveRole.
# Partner event form options (2026-10-20)

`GET /api/portal/options` requires authentication and returns `{ activityCategories: string[] }`, using the same category list as activity validation. Partner forms should load these values instead of maintaining their own subset.

## Business verification form (2026-10-30)

`GET /api/portal/options` now returns `businessIndustries`, a fixed list of 28 selectable industries including `Khác`, alongside activity categories. Industry classification is separate from event categories.

New applications send `accountType` (`business` or `individual`, the latter for a household business), `country: "VN"`, and `certificateNumber` (2–60 ASCII letters/digits, dots, slashes or hyphens; normalized uppercase), plus company/category/website/address and the existing representative/contact fields. `taxId` is optional for these schemaVersion 3 applications. The previous schemaVersion 2 request format remains accepted for older clients. After submission, certificate number, account type and country cannot change on resubmission; an approved company name cannot be edited through application submission.

`document` is the company establishment/business registration or household business registration certificate. Optional `supplementalDocument` uses the same `{name,mime,base64}` structure. Both accept PDF/PNG/JPEG/JPG extensions with matching MIME/signature, max 10 MB each. PDFs are parsed with pdf-lib, must be readable without a password and contain 1–30 pages. Request JSON limit is 28 MB to accommodate two base64 documents. Invalid or oversized files return 400. Older signature-only PDF fixtures must be replaced by valid PDFs.

Files remain private: application lists and `/me` expose only license metadata. A supplemental file is stored in `business_verification_files` separately to avoid MongoDB's per-document size limit. Owner or Admin can download it via `GET /api/portal/applications/:id/document?kind=supplemental`; existing primary download URL is unchanged. Admin review UI includes the supplemental download.

Validation: `node --test tests/business-verification.test.js tests/portal.test.js tests/business-workflow.test.js`.

## Admin and Business Staff separation (2026-10-30)

Only `admin` has platform moderation permissions (business/post approval, reports, cross-account support, user/plan/role management). The legacy global `staff` role no longer grants portal privileges and cannot be assigned through the role API or operator command. Existing real Staff accounts are not automatically promoted. Explicit operators can grant `admin` where appropriate.

Business Staff access is derived from an active assignment provisioned directly by a verified business owner (or a legacy approved/consented assignment). The account's global role remains user; its effective role is `business-staff`, scoped to assigned business groups. It has no platform review permissions.

The demo moderation card uses `demo.admin@gomate.local`. Workshop seeding migrates only explicitly marked `demoScenario: workshop` legacy demo Staff accounts, preserves their password/user ID, and invalidates their previous sessions. It never promotes a non-demo account or overwrites a colliding non-demo administrator. The migration helper can also run independently without reseeding activities.

## Direct business employee provisioning (2026-11-01)

POST /api/portal/staff accepts name, a new email, password, phone, title and groupIds; only business owners may call it. The account and group assignment are active immediately, with status approved and provisionedAt, without staff consent or admin review. Passwords use the normal auth hashing and are never returned. An existing email returns 409. Assigning zero groups is allowed; access to unassigned groups is denied.

PUT /staff/:id accepts the same profile/assignment fields except password, plus version; email identity cannot be changed. Updates take effect immediately and DELETE revokes access. The staff-invitations and staff-requests endpoints no longer exist. Admin remains the only platform reviewer. See business-workflow.md for the detailed contract and legacy compatibility.
