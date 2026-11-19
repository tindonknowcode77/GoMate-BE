# Attendance reputation and member complaints

- Own `/api/profile/me` and existing public reputation include rating and attendance counts.
  Absence rate = absent / (present + late + absent) * 100, rounded to one decimal,
  counting distinct completed activities only. Unmarked/running/cancelled activities
  do not count; an empty denominator returns null, not 0%.
- Activity start sends approved, unmarked members an attendance notice. Direct and
  business starts share the helper; scheduler retries with a stable notification key.
  Marking absent also notifies the affected member. Critical attendance notices
  remain enabled when ordinary activity notices are disabled.
- Authenticated members can GET `/api/community/attendance?page=1&limit=50` (own
  records only) and POST `/api/community/attendance/complaints` with activityId,
  kind (`attendance` or `other`), detail (10–1000 characters), and requestedStatus
  (`present`/`late`, attendance only). Absence or unmarked after start is appealable.
- Existing own reports API shows status and Admin response. Admin report details
  retain the observed attendance, author, timestamp and requested outcome.
  PATCH `/api/community/moderation/attendance-complaints/:id` accepts decision
  (`approve`/`reject`), note (10–1000), and verified status on attendance approval.
  Only Admins can resolve; self-resolution is prohibited. Ordinary moderation
  cannot bypass this operation.
- Resolution claims and activity version checks prevent concurrent/stale updates.
  Corrections append an audit event and lock that result against organizer edits,
  including completion's default-present behavior. Retries do not duplicate audit
  events or notices. Other-issue decisions/rejections do not change attendance.
- Corrections recalculate reputation from source data. They do not change escrow,
  refund money, or settlement approval; financial disputes use the financial flow.
