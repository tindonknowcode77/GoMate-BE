# Current Admin API

All routes below are under `/api/portal/admin`, require a verified authenticated
administrator, and use the existing write rate limiter. Non-admin accounts get
403; unauthenticated requests get 401. Unknown/ambiguous query parameters return
400. Responses never expose password hashes, verification secrets or bank details.

## Dashboard and analytics

- `GET /dashboard-stats?period=week|month` returns the current FE dashboard contract:
  users and role totals, activity totals, bounded pending queues (5 each), upcoming
  activities (5), category totals (20), recent activity (10), daily trend buckets
  (7/30), and growth over the two most recent **completed calendar weeks/months**.
  Week boundaries are Monday, and every date boundary uses Asia/Ho_Chi_Minh.
  Active means `in-progress`; upcoming means published in the next seven days.
  Role totals are disjoint: Admin, approved business owner, personal host, then
  remaining members. Deleted users/records are excluded.
- `GET /analytics/performance` returns attendance (late / present + late), business
  cancellation, and separate top 5 `topCities` / `topDistricts` rankings with recorded
  membership totals. District groups include their parent city; different venues in
  the same region aggregate together. Only structured province/city/district fields
  are used, never venue names or street addresses. Missing districts are excluded
  from district rankings, and records without a city are excluded from both.
  Common HCM/Hanoi/Da Nang aliases are normalized. `topLocations` is retained as a
  city-level compatibility alias. Business
  entries comprise non-deleted business posts and business activities; rejected
  and withdrawn posts plus cancelled activities form the numerator. Post entries
  and activity entries are distinct counted populations.
- `GET /analytics/revenue?type=monthly&year=2026&month=11` returns daily buckets for
  that month. `type=yearly&year=2026` returns 12 monthly buckets. Year range is
  2000–2100. Revenue is **only** `feeAmount` from completed escrow payouts, using
  `processedAt` as the recognition date; net payout amounts and transaction counts
  are separate. Pending transfers, held deposits and legacy ledger entries without
  a completed payout do not count as recognized revenue. Previous period comparison
  is MoM/YoY; growth is null for a positive value with a zero comparison baseline.
  Empty periods include zero-filled buckets.

Add `businessId=<application-id>` to the revenue query to scope the entire report
and comparison period to one business owner. Unknown IDs return 404; malformed or
missing owner mappings are rejected. The business summary adds verified incoming
deposits and completed refunds **in the selected period**, plus held deposits and
pending payouts **as current balances across all periods**. This is platform ledger
activity, not a calculation of the company's external sales or accounting profit.

`GET /business-directory?q=<company>&page=1&limit=20` provides a searched, paginated
company selector. Historical/deleted applications remain available for review;
only identity, owner, company and status are returned, never license documents.

## Business profile investigation

All endpoints below retain the same Admin-only guard. There are no moderation
write actions or impersonated participant sessions in this interface.

- `GET /businesses/:id/history/posts?page=1&limit=20&q=...` lists the owner's posts,
  including deleted/withdrawn entries and recorded status changes.
- `GET /businesses/:id/history/activities?page=1&limit=20&q=...` lists business
  activities owned by the account or linked through its posts, including completed,
  cancelled and deleted history. Personal activities of the owner are excluded.
- `GET /businesses/:id/history/conversations?page=1&limit=20&q=...` lists business
  activity groups and direct conversations involving the business owner account.
  Staff members' unrelated personal direct chats and the owner's unrelated
  personal activity groups are excluded. Search matches conversation titles.
- `GET /businesses/:id/conversations/:conversationId/messages?limit=30&before=...&q=...`
  lists stored message history. `q` searches literal message text; `before` is a
  validated ObjectId cursor. Responses include sender/name, text, timestamp and
  attachment names/kinds. Binary attachment downloads are outside this view.
  A conversation outside the business scope returns 404 even to an Admin using
  this scoped endpoint. Existing participant chat authorization is unchanged.

History lists sort deterministically before pagination; page size is bounded to 50.
Successful reads of posts, activities, conversations and messages are recorded in
`admin_business_access` with administrator ID, business, resource, timestamp and
conversation ID where applicable. Audit entries do not copy message text or search
queries. Indexes support business/admin access review. Reading never creates chats,
joins groups, sends messages or changes participant read/unread markers. All data
comes from records still stored on GoMate; removed external or expired attachment
content is not reconstructed.

## Lists

`GET /users` and `GET /posts` accept the existing `page`, `q`, `status`, `role`
parameters plus `dateFrom`, `dateTo`, `sortBy`, `sortDirection`. Role filtering
remains users-only. Blank legacy role parameters remain compatible.

Dates use `YYYY-MM-DD`, inclusive Vietnam calendar days. Invalid dates, reversed
ranges, repeated parameters and unknown sort keys return 400. Both `createdAt`
and the legacy user `created_at` timestamp are supported. Filtering and sorting
precede the 20-row page limit and total count; `id` breaks sorting ties.

Users allow sort keys `createdAt`, `name`, `email`, `role`, `status`; posts allow
`createdAt`, `title`, `status`. Direction is `asc` or `desc` (default desc).
User status reflects verified/unverified accounts as active/pending; this change
does not add account banning. Roles include derived host/business/staff and custom
role IDs. Sensitive user fields remain excluded from list/detail/write responses.

## Roles and member editing

- `GET /roles` returns system and active custom roles.
- `POST /roles` accepts `{ name, description }` and creates a classification role.
- `PUT /roles/:id` accepts `{ name, description, adminVersion }`.
- `DELETE /roles/:id` accepts `{ adminVersion }` and soft-deletes an unused custom role.
- User POST accepts `{ name, email, password, roleId? }`; user PUT accepts
  `{ name, adminVersion, roleId? }`. Existing clients without `roleId` remain valid.

Only `member`, `admin`, and active custom roles can be directly assigned.
Host/business/staff are derived from existing records, never granted by creating a
custom role with a similar name. Custom roles always retain the underlying `user`
authorization. Role changes increment credential version, invalidating existing
sessions; an Admin cannot change their own role. System roles cannot be edited or
deleted. Duplicate names and stale revisions return 409; assigned custom roles
cannot be deleted. Existing role/subscription mutation endpoints remain available.

Startup initializes indexes for the new `admin_roles` collection and
`users.adminRoleId`; no seed or destructive migration is required.

Regression checks: `npm test` in BE, and `npm run test:admin:contract`,
`npm run test:admin:web`, `npm run test:admin:business` in FE. Tests use temporary
MongoDB instances and test cross-business isolation, unauthorized access, message
pagination/search, audit records, unchanged read markers, and mobile layouts.
