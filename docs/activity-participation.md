# Activity participation contract

Updated 2026-10-26. Deploy the matching FE and BE together.

## Discovery

- `/api/activities` excludes the authenticated host's own activities, blocked hosts, full groups, past starts and closed registration deadlines. Keyword searches retain these constraints.
- The app defaults to all regions, respects explicitly saved filters and refreshes discovery every 10 seconds while browsing. Swiped IDs stay dismissed when the list changes. Search omits empty `q`.

## Invitations require consent

- `initialFriendIds` on creation and `POST /api/activities/:id/members/friends` create private pending invitations and notifications, not memberships. Invitees must already be accepted GoMate friends.
- `GET /api/activities/invitations?page=1&limit=50` lists the current user's pending invitations. Hosts inspect `GET /api/activities/:id/invitations`.
- Recipients send `PATCH /api/activities/:id/invitations/:invitationId` with `{"status":"accepted"}` or `{"status":"declined"}`. Other users cannot decide it. Same-decision retries are idempotent; reissuing a declined invitation creates a new ID.
- Acceptance rechecks eligibility, friendship/blocking, registration deadline, activity status, capacity and version. Only then is an approved membership with source `host-invited` created, enabling chat. Concurrent acceptances cannot overbook.
- Invitations do not reserve seats. `useReservedSeats` consumes a companion place only on successful acceptance. Without an approved outside member, invitations must leave one public place. Hosts can increase capacity or reduce companions.
- Friends and Notifications expose accept/decline actions. Hosts see pending, accepted and declined invitations under Members.

## Confirm, start, finish

- Minimum participants means confirmed GoMate accounts including the host; anonymous companions and unaccepted invitations do not count.
- Confirming schedules and starting both require at least one approved public join request. Legacy `host-added` members and `host-invited` friends do not satisfy that outside-member requirement.
- Capacity minus companions must accommodate the configured minimum. Both FE and BE reject configurations that cannot reach it.
- Public activity JSON includes `readiness` with confirmed/external counts, minimum, readiness and a blocking reason. API checks remain authoritative.
- Start requires a confirmed schedule. Member removal or changes to schedule/capacity/requirements invalidate confirmation. Version checks protect against concurrent membership changes.
- Start snapshots host and approved accounts into attendance. Manual completion requires everyone marked present, late or absent.
- The scheduler marks never-started published activities `expired`, not `completed`. Running activities still auto-complete at the end time, preserving attendance; unmarked users gain no rating eligibility.

## After the trip

- Completed members marked present/late may review actual present/late companions. Submissions are immutable per account/trip with idempotent retries.
- Summary and Rating provide companion friend-request actions. Friendship requires separate recipient approval. Friends supports incoming/outgoing requests, acceptance, rejection, cancellation, removal and direct chat.
- Preserve legacy `host-added` memberships while excluding them from outside-member counts. Historical completions are not rewritten.

## Verification

- `node --test`: 110 tests passed, including independent-account discovery, consent, capacity races, readiness, schedule changes, attendance, ratings, friendships and expiry.
- FE trip/social and lifecycle browser suites use independent browser contexts against a real temporary API/database.
