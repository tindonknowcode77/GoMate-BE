# Mapbox maps/routes with VIETMAP address lookup

Setup: [Mapbox configuration and live verification](../../GoMate-FE/docs/MAPBOX_SETUP.md). Set public `MAPBOX_ACCESS_TOKEN` in ignored `.env`. A secret `sk.` token is never exposed or accepted as the browser token. Add server-only `VIETMAP_API_KEY` for Autocomplete/Place v4; it takes priority for lookup and is never returned to the client. Google Maps keys are no longer read; Google OAuth configuration is unrelated.

## API contracts

All responses are no-store. Authenticated Maps requests allow 60/minute/account and routes another 12/minute/account, per instance. Upstream requests time out after 10 seconds; status/error handling strips provider URLs, token values and raw errors.

| Endpoint | Authentication | Contract |
| --- | --- | --- |
| `GET /api/maps/config` | Public | `provider: mapbox/osm`, public Mapbox `accessToken`, `searchProvider: vietmap/mapbox/none`, `placesEnabled`, `routesEnabled`. |
| `POST /api/maps/places/autocomplete` | Bearer | `{input,sessionToken,bias?}` → `{items:[{id,text,title,subtitle}]}`. VIETMAP Autocomplete v4 with `display_type=1` and optional `focus=lat,lng`, at most 5 results. If no VIETMAP key is configured, Mapbox Geocoding v6 forward uses VN/vi/permanent mode. Input 2–160 chars, at most 20 words, no semicolon, UUID v4 selection session, bounded optional point. |
| `POST /api/maps/places/details` | Bearer | `{id,sessionToken}` → `{place:{id,address,point,components,attributions}}`. One-time selection from the same account/session; 5-minute expiry, bounded 500-entry process cache. VIETMAP calls Place v4 with its cached opaque ref_id; Mapbox fallback consumes its existing permanent result without a second upstream call. |
| `POST /api/maps/routes` | Bearer | `{origin,destination,mode:DRIVE/WALK}` → `{route:{distanceMeters,durationSeconds,encodedPolyline}}`. Directions v5 driving/walking, full route polyline5, no traffic prediction. |

The selection cache holds either VIETMAP ref_id/display/boundaries or permanent Mapbox results. A VIETMAP selection requires the same owner/session; Place v4 validates numeric bounded coordinates and maps city/district/ward to the existing component contract. In-flight selection blocks duplicate provider calls; failed lookups remain retryable and success consumes the selection. Coordinates/address may be saved via existing activity/chat APIs. No autocomplete list or route is written to DB. Cache is per process; after restart/cross-instance selection, search again.

Mapbox remains the map/route provider. VIETMAP can search without Mapbox (OSM map, routes disabled). A configured but failing VIETMAP key does not silently fall back to Mapbox. Only omit VIETMAP config to use permanent Mapbox address geocoding; that path remains address-only and requires Mapbox permanent-geocoding eligibility. Search Box is not used.

URLs and provider query options are fixed server-side; VIETMAP key/ref_id remain on BE. A Services key is required; HTTP 423 quota/permission denial becomes a sanitized 503. No arbitrary URLs or provider options accepted. Reject malformed coordinates and route data. Statuses: 400 contract validation, 401 unauthenticated, 404 expired selection/no route, 429 rate limit, 502 malformed upstream, 503 provider denial/unconfigured token, 504 upstream network/timeout.

## Rendering and bridge

`/map.html` selects Mapbox GL JS 3.33.0 / streets-v12 when configured, original Leaflet/OSM otherwise. CSP Mapbox script/style/connect/blob worker allowances apply only to this page; frame ancestors remain self plus configured frontend origins. SDK preserves its logo and source attribution. No Google scripts, API dependencies or native Mapbox SDK are required.

Browser messages validate parent origin/source; native uses the WebView message bridge. Click/drag publishes coordinates; radius is a geodesic GeoJSON polygon. Route messages decode polyline5 into a GeoJSON line and origin marker without iframe reload; null clears them. Late route messages are buffered until style load. App tokens are never sent to the map; the public Mapbox token is fetched through public config.

Frontend lookup debounces 450 ms and ignores stale results. Confirmation updates address/region/point or a chat location draft. Routes request GPS only after an explicit tap. Match straight-line/radius queries continue to use MongoDB geographic queries, not Directions calls per result. External map fallback uses OSM.

## Verification

- `node --test tests/maps.test.js tests/vietmap.test.js`: real HTTP authentication/validation, permanent geocoding, selection owner/session/single-use, route profiles/shape, failures, rates, CSP and secret-token rejection with provider doubles.
- FE `npm run test:maps:web`: actual FE/BE/MongoDB with fake provider for deterministic UI and persistence testing.
- FE `npm run test:maps:live`: opt-in real provider/SDK verification from local `.env`. Small number of potentially billable calls; no token output. Local hybrid live calls passed on 2026-10-16: VIETMAP Autocomplete/Place, Mapbox routes, rendered tiles and route overlay.
- Physical iOS/Android WebView/GPS and deployment-specific token/domain restrictions still require testing. Public demo/deployment should review Mapbox terms, attribution, budgets and privacy disclosures.
