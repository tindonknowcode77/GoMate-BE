# Match preferences and discovery

All `/api/me/*` endpoints require the current bearer session, derive the user
from it and return `Cache-Control: no-store`.

- `GET /api/me/match-preferences` → `{filters: object|null, favoriteIds: string[]}`.
- `PUT /api/me/match-preferences` accepts the bounded filter object directly:
  province, district, distance, radiusEnabled, organizerType (all/personal/business),
  sort (recommended/nearest/soonest), categories, availableDays (T2…CN), timePeriods
  (Sáng/Chiều/Tối), minBudget/maxBudget, minimumCapacity/maximumCapacity,
  dateFrom/dateTo (DD/MM/YYYY), fromTime/toTime (HH:mm), preferences. Empty fields
  mean unrestricted. Reject invalid lists/ranges, GPS coordinates, deposit fields
  and unknown fields. Precise search points are intentionally not persisted here.
- `POST /api/me/match-feedback` accepts `{activityId,outcome}` with outcome
  skip/interested/dislike/favorite; derive the category from the stored activity,
  limit writes to 120/min and cap per-category scores at −10…10.
- `PUT /api/me/favorites/:id` saves a live activity idempotently (maximum 500 IDs).
- `DELETE /api/me/favorites/:id` removes a favorite, including one later deleted.
- `GET /api/me/favorites?page=1&limit=20` returns paged public activity fields,
  including lifecycle status, omitting deleted activities.

Activities accept `organizerType=personal|business` on create/update. Older records
without this field count as personal in discovery. Classification is declared by
the host and does not assert verification. Discovery accepts `organizerType`,
`sort=recommended|nearest|soonest`, `lat`, `lng`, `distanceKm`. Nearest and radius
require a complete coordinate pair. Geographic queries use the 2dsphere index,
return distanceKm and omit unpinned activities. Recommendation scores are computed
before paging using user interests and bounded feedback; default non-Match searches
retain chronological ordering unless geographic search applies.

`GET /api/auth/google/config` exposes only `{clientId: string|null}` for the public
web client ID; token validation and account/session semantics remain on BE.

Profile cover endpoints: `PUT /api/profile/me/cover` accepts `{base64}` with one
JPEG/PNG/WebP up to 10 MB; `DELETE /api/profile/me/cover` removes it. Covers are
normalized to WebP at 1600×600, retain a separate cover version, and clean uploaded
assets on failed CAS writes and old assets after successful replacement/removal.
Public profiles expose coverUrl, never storage IDs or private Match settings.

The map document and Leaflet runtime are served locally at `/map.html`,
`/map-ui/*`, `/map-assets/*`. Only OSM tiles are external. Map frame embedding is
limited to self and valid HTTP(S) origins in CORS_ORIGIN. Map coordinate messages
are bounded and checked by the client before use. No account token is embedded
in the map URL or sent to the tile provider.
