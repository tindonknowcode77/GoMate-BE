# Activity drafts and member portraits

## Account draft

The create editor can explicitly save one unfinished new activity per account. Drafts are not activities and never appear in Match, membership or chat until normal publication succeeds. `GET /api/activity-draft` returns `{draft: null}` or `{draft: {version,savedAt,state:{step,customCategory,data}}}`. `PUT` accepts `{version,state}`, including incomplete fields; `DELETE` accepts `{version}`. All endpoints authenticate, scope data to the session user and return no-store responses. PUT allows ten saves/minute/account and an 88 MiB JSON payload.

The UI saves/restores the editor step, custom category, group/companion data, photos and Excel attachment. It keeps image base64 without duplicated data/blob URLs, then reconstructs usable data URIs on restore. Restoring does not depend on browser temporary URLs or device cache paths. Publishing still runs the ordinary full validation/upload flow. Successful publication attempts to delete the saved draft; discard requires confirmation. Draft edits do not change a published activity. Saving drafts for edits/multiple drafts is outside the current create-only flow.

MongoDB `activity_drafts` stores owner/file/version/time; `activity_draft_data` is a GridFS bucket for the JSON body. This supports six 10 MB photos plus a 3 MB Excel file without exceeding the BSON document size. Validation bounds input types, images, list lengths and structured content, while permitting unfinished fields. Unique owner metadata and optimistic version checks prevent overwriting another editor session. New files are staged before swapping the metadata pointer; old/rejected files are cleaned on normal save/delete paths. An interrupted process between GridFS upload and pointer commit can leave an orphan; production should add storage reconciliation. Large responses/uploads use a longer client timeout.

The editor loads an existing draft automatically and blocks creation with a retry message if loading fails, so a network error does not silently overwrite an existing draft. Changes made after pressing Save require another Save; this is explicit saving, not background autosave. A conflicting version asks the user to reload. A newer draft from another session is not deleted by an old publication cleanup.

## Member portraits

Owned/joined activity lists include up to four current host/approved-account profiles in `memberAvatars`, fetched in batches from the users collection. Pending requests and private companion names are excluded. No portrait is invented for a reserved seat. Home renders the real stored profile image and a neutral gray silhouette for absent/failed images, including reserved companions. These lists are authenticated; public discovery does not gain a membership list.

## Demo friends for the requested account

Run `npm run db:seed-user-friends` in BE after setting local DB configuration. The default target is `pminh2004@gmail.com`; `DEMO_FRIEND_OWNER` can override it. The target must exist. Five `pminh.friend1@gomate.local` … `pminh.friend5@gomate.local` demo accounts have complete basic/extended profiles, different remote portrait URLs and accepted friendships with that target. Accounts are fictional demos; portraits use the existing Random User demo photo source. `DEMO_PASSWORD` applies on initial creation, default `gomate123`. Re-running preserves existing account credentials and unrelated data; the target account is not rewritten.

The script was executed against the configured database: five profiles, five accepted friendships, five distinct avatar URLs; each remote portrait returned HTTP 200. Tests use separate temporary databases.

## Verification

`tests/drafts.test.js` checks private partial drafts, payloads beyond 16 MB, media/plan/step round trips, versions, cleanup, additive/idempotent friend seeding, and current-member portrait privacy/refresh. FE trip UI tests cover keyboard entry, saved drafts across navigation/reload, publication cleanup, composer layout/text preservation and actual/fallback participant avatars. Physical-device keyboard/WebView behavior still needs manual testing.
