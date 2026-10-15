# Personal activity publishing and group management

The authenticated consumer API accepts only personal activity creation. `POST /api/activities`
rejects `organizerType: "business"` with 403. `PATCH /api/activities/:id` also rejects
conversion to business and editing existing business records. Browser headers and
running the consumer app on web do not grant business publishing rights. Existing
business discovery records remain visible through organizer filters. A dedicated,
authorized business website publishing service is outside this consumer API.

The activity category enum now includes 56 categories, including coffee, individual
sports, board games, workshops, outdoor activities, arts and volunteering. FE and
BE use the same category values; unsupported custom labels continue to use `Khác`
plus a tag.

## Confirming the schedule

`POST /api/activities/:id/confirm-schedule` accepts only `{ "version": <current version> }`.
It requires the host, a published future activity and the current version. It saves
`scheduleConfirmedAt`/`scheduleConfirmedBy` and a `schedule-confirmed` audit entry
atomically using the activity version. A repeated confirmation of the same confirmed
version is idempotent. A stale version returns 409; non-host access returns 403.
Changes to start/end, location, meeting point, address or coordinates clear confirmation.
Members see the confirmed state in the activity and conversation metadata. Confirmation
does not start an activity or prevent existing members from chatting.

Existing host endpoints handle approvals/rejections, friends/members, activity editing,
start, attendance, completion and deletion. The redesigned UI calls these endpoints;
permissions remain enforced server-side. Deletion revokes group chat access through
the repository's live activity membership check.

## Inbox metadata

Conversation summaries include actual profile/activity `avatarUrl`, group `hostId`,
`memberCount`, `activityStatus`, `startsAt` and `scheduleConfirmedAt`. No online/typing
or read-by-everyone state is invented. Inbox pagination sorts by the most recent
message, falling back to conversation creation time, before pagination.

Relative registration deadline presets are resolved by FE to an absolute UTC
`registrationDeadline`. Existing API validation requires a future deadline no later
than activity start. The repository stops new requests at the stored deadline.
