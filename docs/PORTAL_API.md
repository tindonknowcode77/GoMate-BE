# Business, Staff and Admin portal

The web portal is available at `/portal` on the same server as the exported Expo app. It uses the existing email/password registration, email verification, password recovery and bearer-session APIs. Registration does not grant Staff/Admin privileges. A verified user can submit a business application; approval grants business access on the next request.

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

Replace the email with the intended operator account. This command also supports `staff` and `user`; it revokes existing sessions. No administrator is seeded automatically and no demo password is accepted by the portal.

## Routes

All routes below start with `/api/portal` and require `Authorization: Bearer <token>`. List routes use `?page=1` with pages of 20 items.

| Method | Route | Access / behavior |
| --- | --- | --- |
| GET | `/me` | Current identity, effective role, subscription, own application |
| POST | `/applications` | Verified user; submit/resubmit a rejected business application |
| GET | `/applications` | Admin; application list, without document contents |
| GET | `/applications/:id/document` | Admin; private attachment download |
| PATCH | `/applications/:id` | Admin; pending → approved/rejected, optional reviewNote |
| GET | `/posts` | Business: own posts; Staff/Admin: moderation list |
| POST | `/posts` | Approved business; creates a pending post |
| PATCH | `/posts/:id` | Staff/Admin; pending → approved/rejected |
| GET | `/feed` | Any authenticated user; approved business announcements only |
| GET | `/metrics` | Business: own counts; Staff/Admin: system counts |
| GET | `/users` | Admin; safe user fields and subscription |
| PATCH | `/users/:id/subscription` | Admin; plan free/plus, status active/paused/cancelled |
| GET | `/reports` | Staff/Admin; existing community report queue (up to 200 records) |
| PATCH | `/reports/:id` | Staff/Admin; resolved/dismissed and hideActivity boolean |
| GET | `/tickets` | Own tickets; Staff/Admin can see all |
| POST | `/tickets` | Any verified user; subject and message |
| POST | `/tickets/:id/replies` | Owner or Staff/Admin; message and status |

Applications accept `company`, `category`, optional `website`, and `document: {name, mime, base64}`. Documents are PDF/PNG/JPEG, up to 10 MB, with file-signature validation. They are stored privately in MongoDB and excluded from list responses. Downloads are attachments, never inline HTML. A rejected application can be resubmitted; concurrent or repeated decisions return 409.

Posts accept `title`, `copy`, `premium`, `badge`, `discount`, and `border` (Soft/Glow/Solid). Premium creation requires an active Plus plan on the server. Posts are business announcements, separate from personal activity membership/scheduling APIs. Approved posts are visible in the portal's published feed; the existing mobile activity feed is unchanged.

Subscriptions are administrative entitlements, **not payments**: no charge, invoice, payment provider, renewal job or revenue claim is made. Owners can request changes via support; only Admin changes entitlements. Existing approved posts keep their historical decoration if a plan is later paused.

Support threads are persisted, ownership checked, and limited to 100 messages per ticket. Owner replies reopen a ticket. Staff/Admin can close it with a reply. The portal exports real aggregate metrics as JSON.

## Verification

```powershell
node --test tests/portal.test.js
```

The tests use an isolated MongoDB memory-server database. For a locally installed mongod, set `MONGOMS_SYSTEM_BINARY` to its executable and `MONGOMS_VERSION` to its installed version. Run `node tests/portal.web.cjs` in `GoMate-FE` after exporting with `/api`; the browser test creates isolated accounts and exercises application approval, subscriptions, posts, moderation, tickets and mobile layout.

The portal also reuses the configured Google sign-in button from the application. Google login requires the existing provider configuration; the browser tests exercise email/password login. Apple sign-in and native push notifications are outside this portal implementation. OAuth provider setup is not provisioned by these changes.

## Admin role assignment

PATCH `/api/portal/users/:id/role`, body `{ "role": "staff" }`. Allowed roles: user, staff, admin. Admin authorization required; target email verification is not required. Role assignment does not verify the email. Self changes return 409; missing users return 404. Successful updates invalidate previous sessions through credential_version and record roleUpdatedBy/roleUpdatedAt. Business remains derived from an approved application; selecting user does not revoke an approved business application. GET /users includes email_verified and effectiveRole.
