# Realtime and data-loading architecture

Updated: 2026-11-20.

## Transport and durable state

MongoDB remains the source of truth. Sending messages and marking them read use
authenticated REST writes; history uses cursor pagination. Socket.IO uses one
WebSocket per signed-in app, shared by active chat and unread/inbox subscriptions.
Tokens travel in the Socket.IO auth payload, never in URL query parameters.

The server authenticates the connection and checks session validity and current
conversation access before delivering a conversation snapshot. Revoked membership
removes the subscription. Session revocation disconnects the socket. Disconnect
cleanup removes event listeners and timers.

Repositories sharing the same database object publish commit notifications through
`src/common/realtime-events.js`. Successful activity/portal mutations invalidate
active conversation snapshots. A changed snapshot updates FE metadata directly;
FE loads message deltas only when needed, rather than fetching metadata again.
The legacy SSE endpoint remains available with event-triggered updates and a
30-second reconciliation interval instead of a one-second database loop.

Reconciliation every 30 seconds repairs updates from schedulers, other API
processes and missed events. FE uses slower REST fallback when WebSocket is
unavailable. A disconnected client reloads durable state when it reconnects.

## History and unread correctness

`GET /api/conversations/:id/messages?after=<ObjectId>&limit=100` returns messages
in ascending cursor order, with `hasMore` and `nextCursor`. `before` remains the
descending history interface. Combining both cursors is rejected.

FE drains all forward pages before advancing its newest-seen/read marker. This
prevents a reconnect after more than 50 new messages from leaving a hidden gap.
Retries merge messages by ID. Portal chat only marks a changed newest message
read, rather than issuing the same PATCH every polling cycle.

`GET /api/conversations/unread-count` counts unread messages across currently
authorized conversations without provisioning groups, synchronizing activity
events, fetching every list page, or assembling full conversation summaries.
Inbox search/type/unread filters run on BE before pagination.

## Database work

- Known group access checks inspect that group rather than rebuilding the user's
  complete campaign audience scope. Staff and business visibility checks remain.
- Activity-message repair queries existing event keys and upserts only missing
  events. Concurrent repair is protected by the existing message uniqueness index.
- Conversation lists resolve membership once and batch summaries, read markers,
  activity metadata, user profiles and message counts instead of querying each row.
- Discovery batches host rating, completed-activity and attendance aggregates.
- Withdrawn, cancelled or missing saved audience assignments are re-evaluated
  when choosing the visible campaign group.
- `MONGODB_MAX_POOL_SIZE` defaults to 20 (valid range 1–200). Pool checkout waits
  are bounded to five seconds; pool size is a deployment tuning input.

The isolated regression fixture measures a group with 100 already-delivered
activity updates:

| One authorized repository snapshot | Before | After |
| --- | ---: | ---: |
| MongoDB commands | 118 | 8 |
| Write commands | 101 | 0 |

These are command counts for the fixture, not production latency or throughput
claims. Authentication and other simultaneous app requests are outside this table.

## FE loading and HTTP delivery

- Concurrent identical GETs share one in-flight request, scoped by session and
  request options. Caller-owned cancellation remains independent. Mutations
  invalidate in-flight reuse so a subsequent read starts fresh.
- `useRemote` joins background refreshes already running, avoiding overlapping
  requests and generation starvation on slow networks. A foreground action can
  queue one fresh read after an older request completes.
- Discovery loads only when opened. Discovery, inbox and notifications load
  explicit pages instead of exhausting pagination. Duplicate IDs are merged.
- Portal loads resources for the active section. More pages require an explicit
  action; notification totals remain independent of the displayed page length.
- Live list refreshes are debounced and pause when the app is in the background.
- Compressible HTTP responses use compression. SSE and media range responses are
  excluded. Content-hashed static assets use immutable caching; HTML and
  unversioned files revalidate.

## Deployment and verification

Deploy FE and BE together, restart BE, and allow WebSocket upgrades on
`/socket.io/` through the reverse proxy. Configure `CORS_ORIGIN` for the FE origin.
The normal database initialization adds the host/status index. Existing documents
and cursor history remain compatible; there is no destructive data migration.

Run `npm run test:realtime` in each repo. In FE, export the web build using a
same-origin API configuration and run `npm run test:realtime:web` for the isolated
browser scenario. The browser test verifies live delivery, no repeated idle
history HTTP requests, recovery of 125 missed messages, lazy discovery, and portal
resource loading/pagination. Tests use temporary MongoDB instances.

This event bus is local to an API process. Multiple API processes converge through
30-second reconciliation; strict immediate delivery across instances requires a
shared event broker/adapter or MongoDB change streams. Reconnect recovery must
remain even after adding such infrastructure. Large message histories still make
unread/count aggregation more expensive; measure staging p50/p95 latency, command
counts and pool checkout time before introducing materialized counters or raising
the pool further. Native device runtime and deployed network latency require
separate verification.
