# Trip plans, companion seats and friends

Activity create/update supports `address`, `province`, `district`, `ward`, `costNote`,
`reservedSeats`, `itinerary`, `planLink`, and `planAttachment`. Creation also accepts
`initialFriendIds` (up to 50 unique accepted friends); edits use the members endpoint
instead. All counts derive from server data. `memberCount` includes host, approved
accounts and offline `reservedSeats`. Reservations never create fake accounts,
join requests, attendance identities or chat access.

Itinerary contains at most 60 steps `{id,date,time,title,place,note}`. Dates use
YYYY-MM-DD and times HH:mm in Vietnam time, within the activity's start/end range.
Steps sort chronologically. Legacy text `plan` remains readable. `planLink` is an
optional HTTPS URL without credentials; BE never fetches or parses its content.

One `planAttachment: {name,base64}` accepts .xlsx/.xls up to 3 MB, checking safe
filename/extension and container signature. `null` removes it; omission preserves
it. Original bytes are not parsed/executed. Store metadata in `planFile` and private
bytes in `planFileData`, excluding bytes from every JSON/list/discovery projection.
Remove bytes when the activity is deleted. Download with authenticated
`GET /api/activities/:id/plan-file?version=:fileId`; response is attachment + octet
stream + nosniff. Published activity files are accessible to authenticated viewers;
after start/completion only the host/approved members retain access.

`PATCH /api/activities/:id/plan` accepts `version` and itinerary/planLink/
planAttachment. Only the host may change it, while published/in-progress. Stale
versions and completed activities reject writes; no partial plan/file mutation.

`POST /api/activities/:id/members/friends` accepts `{friendIds,useReservedSeats}`.
Only the host of an upcoming published activity may add accepted friends. Check
profile preferences, uniqueness, current capacity and version. With reserved-seat
conversion, reduce reservations by up to the number of new account members and
increase occupancy only for the remaining accounts. Repeated additions do not
count an existing approved member again. Revive prior request entries rather than
creating duplicate memberships. Group chat checks live membership on each access.

Preferences add optional `minAge`/`maxAge` (0 means unrestricted, otherwise up to
120, ordered). Calculate age from volunteered birthDate; unknown ages cannot meet
an age-limited group. Discovery query age ranges match overlapping group ranges;
unrestricted groups still appear. Existing gender/language/religion/alcohol/dress
API fields remain compatible.

Friends endpoints (bearer session, no-store):

- `GET /api/friends?page=1&limit=20`: accepted friends.
- `GET /api/friends/requests`: pending incoming/outgoing requests.
- `GET /api/friends/search?q=...`: up to 20 public name/Nickname matches (2–60 chars).
- `GET /api/friends/:userId`: relation id/status/direction for the current pair.
- `POST /api/friends/requests {userId}`: create/idempotently read a pair request.
- `PATCH /api/friends/requests/:id {status:accepted|declined}`: recipient-only decision.
- `DELETE /api/friends/:userId`: cancel/remove the current user's relationship.

Use a unique pair key plus participant/status indexes. Public results omit email,
birth date, credentials and private profile details. Writes and searches are rate
limited. Removing a friendship does not remove previously joined activity membership.

Chat summary adds resolved names/activity titles. `GET /api/conversations/:id`
returns an authorized summary for deep links. Messages include senderName derived
on BE; existing messages without it use a generic label. Existing idempotency,
paging, read markers, SSE revocation and two-person direct chat behavior remain.
The FE now uses these APIs rather than sample chat data; early group creation is
allowed for host/approved accounts, independently of start time.

See FE `docs/ACTIVITY_CREATION_AND_FRIENDS.md` for UI, geography snapshot provenance
and native limitations. Run `node --test tests/trip-social.test.js` with the cached
MongoDB binary for the new authorization/capacity/plan/social integration coverage.
