# Chat content and companion information

All endpoints require the existing Bearer session. Conversation access is checked
against current direct participants/blocks or activity host/approved membership,
including downloads and shared-content queries.

## Chat endpoints

- `POST /api/conversations/:id/attachments`: multipart with one `file` field, no
  other fields. Maximum 10 MB; 12 uploads/minute/IP. File headers are checked and
  image metadata is bounded to 25 million pixels. Returns
  `{ attachment: { id, name, size, mimeType, kind } }`.
- `POST /api/conversations/:id/messages`: existing `text` and `clientMessageId`,
  plus optional `attachmentIds` (maximum four unique IDs owned by the sender and
  belonging to this conversation) and `location: { latitude, longitude, label }`.
  Content can be attachment-only/location-only. Retry IDs reject changes to text,
  attachments or location with 409. Same-owner attachment reuse is permitted in
  the same conversation, including retrying an edited draft after network loss.
- `GET /api/conversations/:id/attachments/:fileId`: private/no-store binary;
  pending uploads are visible only to their owner. Sent uploads are visible to
  current conversation members. File downloads force attachment disposition;
  images/video/audio use their detected media MIME. Accepts a single HTTP byte
  range for native playback/seeking and returns 416 for invalid ranges.
- `GET /api/conversations/:id/shared?kind=media|files|links|locations&limit=30&before=...`:
  descending message cursor pagination, same response shape as history. Legacy
  text messages are included in link search; returned links allow only HTTP(S)
  without embedded credentials. No remote page fetches or link scraping occur.

Messages keep only attachment metadata and an explicit location snapshot, never
raw binary. `chat_attachments` stores separate MongoDB Binary documents (each is
below MongoDB's 16 MB document limit). Unsent uploads have a 24-hour TTL. The
upload path checks a 250 MB sender/conversation storage budget; this is not a
transactional distributed quota. Media storage, thumbnails/transcoding, malware
scanning and durable retention jobs should move to private object storage before
increasing capacity. Run the existing database migration to create TTL/lookup
indexes when deploying to an existing database.

Supported upload formats: JPEG, PNG, WebP, MP4/MOV, WebM, MP3/OGG/WAV, PDF,
ZIP/Office and UTF-8 TXT/CSV. Container/header checks do not guarantee a playable
codec or a valid Office document. The FE reports unsupported uploads, retains
successfully uploaded draft items and provides a download path for shared files.

## Companion endpoints

- Create/edit activity accepts optional `companions: [{ name, note }]`, aligned
  with `reservedSeats`. Maximum name 80 and note 200 characters; missing entries
  are padded with empty values, excess entries rejected. Reducing seats trims
  only entries beyond the remaining capacity when companions are not supplied.
- `GET /api/activities/:id/companions`: host/approved members only, returns
  `{ companions, version }`.
- `PATCH /api/activities/:id/companions`: `{ version, companions }`, host only,
  before start while published. Concurrent version changes return 409. Strictly
  validates editable fields; cannot change capacity or membership through this API.
- Names/notes are omitted from public activity/Match responses. The host's
  activity detail includes them for editing. Reserved seats never create users,
  sessions or chat participants. Adding real friends using reserved seats removes
  the first consumed companion entries and updates capacity atomically.
- Activity detail and Match discovery use the host's current avatar, including the
  legacy avatar-version fallback, rather than a copied avatar at publication time.

Validation: `tests/chat-content.test.js` covers privacy, versions, capacity
conversion, multipart limits, authenticated downloads/ranges, ownership, message
idempotency, library pagination and access revocation. FE's two-account trip test
exercises the composer, image/video viewer, GPS snapshot and shared-content UI.
