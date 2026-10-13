import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activityFields } from '../src/modules/activities/validation.js'

test('activity creation validates funding, calendar dates and deadlines without dropping draft fields', () => {
  const body = { title: 'Meetup', description: 'Meet new friends', location: 'Saigon', category: 'Ăn uống',
    startsAt: '2099-01-05T02:00:00Z', endsAt: '2099-01-05T04:00:00Z', estimatedCost: 100000, maxParticipants: 6,
    meetingPoint: 'Main gate', registrationDeadline: '2099-01-04T12:00:00Z',
    financialConfig: { fundingMode: 'DEPOSIT', estimatedCostMin: 100000, estimatedCostMax: 200000, depositAmount: 50000,
      approvalThreshold: 1000000, approvalRule: 'TWO_THIRDS', treasurerUserId: 'host-1', paymentDeadline: '2099-01-04T12:00:00Z' } }
  const fields = activityFields(body)
  assert.equal(fields.meetingPoint, body.meetingPoint)
  assert.equal(fields.financialConfig.depositAmount, 50000)
  assert.equal(fields.financialConfig.paymentDeadline.toISOString(), '2099-01-04T12:00:00.000Z')
  for (const patch of [{ depositAmount: -1 }, { depositAmount: 300000 }, { estimatedCostMin: 300000 },
    { approvalThreshold: 1.5 }, { approvalRule: 'INVALID' }, { treasurerUserId: '' }, { fundingMode: 'INVALID' },
    { paymentDeadline: '2099-02-30T00:00:00Z' }, { paymentDeadline: '2099-01-06T00:00:00Z' },
    { paymentDeadline: '2000-01-01T00:00:00Z' }, { extra: true }]) {
    assert.throws(() => activityFields({ ...body, financialConfig: { ...body.financialConfig, ...patch } }), error => error.status === 400)
  }
  for (const registrationDeadline of ['2000-01-01T00:00:00Z', '2099-01-06T00:00:00Z', '2099-02-30T00:00:00Z']) {
    assert.throws(() => activityFields({ ...body, registrationDeadline }), error => error.status === 400)
  }
})
