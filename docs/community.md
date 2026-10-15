# Account settings, notifications, ratings and safety

All endpoints below require a live Bearer session under `/api/community`. Request
identity always comes from the session, never from a submitted user ID. Writes
are rate limited and unknown fields/types are rejected.

## Settings

`GET /settings` and `PATCH /settings` read/update the current account. Accepted keys:

- `allowFriendRequests`, `discoverable`: booleans governing incoming invitations
  and appearance in friend search. Existing friends/groups are not removed.
- `directMessages`: `everyone` or `friends`. Enforced on creation and sending in
  existing direct conversations. Existing readable history remains available.
- `notifyActivity`, `notifyMessages`, `notifyFriends`: control creation of future
  in-app notifications, without suppressing actual messages or activity changes.

## Notifications

`GET /notifications?page=1&limit=30` returns paged real records plus `unreadCount`.
`PATCH /notifications/:id/read {}` marks one owner-scoped record, while
`PATCH /notifications/read {}` marks all. Foreign IDs return 404.

Records are produced by friend invitations/acceptance, join requests/decisions,
messages, schedule confirmation, activity start/completion, edits, shared plan updates, host additions, cancellation and host notes. Unique
recipient/event keys deduplicate retries. Message content is bounded to 160 chars.
Blocked actors are excluded from notifications and unread counts. Reading chat
also marks preceding message notifications as read. This is an in-app inbox;
OS push delivery/device-token registration and scheduled reminders are not enabled.

## Ratings and reputation

`GET /ratings/:activityId` returns the actual eligible people and the caller's
submission, if any. The activity must be completed and the caller must be host or
approved member marked present/late. Only present/late fellow participants can be
rated; self and outsider targets are rejected.

`POST /ratings/:activityId` accepts:

```json
{"score":5,"comment":"Helpful group","members":[{"userId":"UUID","score":4}]}
```

Scores are integers 1–5, comments at most 1000 chars. One immutable submission per
author/activity is protected by a unique index. Identical requests are idempotent;
changed duplicates return 409. Member score upserts can repair an interrupted retry.
Overall experience stays on the submission; optional member scores feed actual
`/api/profile/me/reviews`, public reputation and Match host scores. Completed host
activity counts are queried from actual completed activities.

## Blocking

`GET /blocks`, `PUT /blocks/:userId {}`, `DELETE /blocks/:userId` operate only on the
caller's list. Blocking removes the friendship and bilaterally denies direct chat,
new friend invitations, profile viewing, friend search, Match discovery of the host
and new join requests. Existing group membership/history remains accessible; use
host member management or leave a group separately. Unblocking does not restore
deleted friendships. No mock blocked accounts are shown.

## Reports and moderation

`POST /reports {activityId,reason,detail}` persists an activity report (detail <=1000
chars). Own activities cannot be reported. One report per reporter/activity is
idempotent. `GET /reports` returns only the caller's most recent 100 reports.

`GET /moderation/reports` returns at most 200 reports. `PATCH /moderation/reports/:id`
accepts `{status: "resolved"|"dismissed", hideActivity: boolean}`. Only a provisioned
database account with `role: "admin"` can access either endpoint. This role is read
from BE; registration/profile/settings payloads cannot assign it. No live admin
account is created by this change. Hiding requires `resolved`, soft-deletes the
activity and revokes group chat through existing live membership checks. The
decision records administrator/time and notifies the reporter. Retrying the same
administrator decision is idempotent. An operator UI and production staffing are
separate from the consumer app; there is no automatic report approval.

## Verification

`tests/community.test.js` covers persistence, preference enforcement, notification
ownership/deduplication, rating eligibility/duplicates, moderation roles, blocking
and group preservation. FE `tests/community.web.cjs` uses isolated accounts and a
temporary MongoDB database to exercise the corresponding UI end to end.

Notification storage failure is logged and isolated from primary writes (for example, a
successful activity upload is not undone). A durable outbox/worker and provider push
are separate production reliability work; no guaranteed-delivery SLA is asserted.
