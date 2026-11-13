# Admin CRUD

All routes below are under `/api/portal/admin` and require a verified, authenticated account whose current database role is `admin`. Existing business/staff roles receive 403. Documents and password/token fields are excluded from list/detail responses.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/:kind?page=1&q=&status=` | Search and filter, 20 rows per page, `{items,total}` |
| GET | `/:kind/:id` | Read details and current versions |
| POST | `/:kind` | Create, returns 201 |
| PUT | `/:kind/:id` | Edit allowed fields with current `adminVersion` |
| DELETE | `/:kind/:id` | Archive with current `adminVersion`; posts use the existing lifecycle |

Supported kinds and payloads:

User lists accept an optional `role=admin|business|business-staff|staff|user` filter. It matches the displayed `effectiveRole` before pagination and counting: admin takes precedence, followed by approved business ownership, then accepted/provisioned staff membership in an approved business, and finally the stored role (default user). Search combines with this filter. Empty `role=` is accepted on every kind for compatibility with older portal bundles; nonempty roles are valid only for users.

- `users`: create `{name,email,password}` using existing credential validation/hash. New accounts require email verification. Edit `{name,adminVersion}`. Email is immutable; role and subscription changes use existing `/portal/users/:id/role` and `/subscription` PATCH endpoints.
- `businesses`: create `{ownerId,application}` with the existing application schema, including a validated PDF/PNG/JPEG license. Edit `{company,address,website,representativeName,representativeTitle,representativeEmail,representativePhone,version,adminVersion}`; verified identity fields stay immutable. Delete requires both versions and no pending, approved or publishing posts.
- `posts`: create `{ownerId,post}` for an approved business using existing post validation. Edit `{post,version,adminVersion}` only while pending/rejected; the lifecycle `version` controls conflicts. Delete requires both versions and reuses the existing group lifecycle.
- `reports`: create `{activityId,reason,detail}` for an existing activity, edit `{detail,adminVersion}` while pending. Resolve/dismiss via existing `/portal/reports/:id` PATCH; archive only after review.
- `tickets`: create `{ownerId,subject,message}`, edit `{subject,status,adminVersion}` with status `open|closed`. Reply via existing `/portal/tickets/:id/replies` POST. Replies advance `adminVersion`; archive only after closing.

Stale versions return 409; invalid fields return 400. Deleted accounts cannot log in or use existing sessions. Self/admin deletion is blocked. Account deletion requires resolving active applications and hosted activities. Archived records preserve history; email/owner uniqueness remains reserved, and no restore endpoint is provided. Archived support tickets cannot be reopened by replying. Admin business/post approval continues through the existing reviewed endpoints and version checks.

Validation rejects duplicate/unknown query parameters, noncanonical page numbers (including exponent/decimal notation), unsupported status filters and invalid reference-ID characters. Page range is 1–10000; search is at most 120 characters. References are trimmed before both lookup and persistence. Versions must be safe nonnegative integers, and `adminVersion` is mandatory for post edits as well as other resources. Role/subscription changes advance user `adminVersion`. User names require 2–100 trimmed characters; new passwords cannot be whitespace-only. Admin post discounts must be numeric integers 0–100 (null/string values are rejected). Optional whitespace-only content is normalized to empty. Ordinary admin request bodies are limited to 32 KB (413 on overflow); business creation retains the 28 MB envelope for validated license documents.

Run `node --test tests/admin-crud.test.js` for authorization, CRUD, conflicts, search escaping, lifecycle reuse, private-field exclusions and session revocation. Browser coverage is in `../GoMate-FE/tests/admin-crud.web.cjs`; build FE with `EXPO_PUBLIC_API_BASE_URL=/api` before running it.
