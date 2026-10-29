import assert from 'node:assert/strict'
import { test } from 'node:test'
import { businessWallet } from '../src/modules/portal/wallet.js'

test('manual reconciliation deduplicates members and never makes funds withdrawable', () => {
  const row = { id: 'one', title: 'Group', status: 'completed', joinRequests: [
    { userId: 'a', status: 'approved' }, { userId: 'a', status: 'approved' },
    { userId: 'b', status: 'approved' }, { userId: 'c', status: 'rejected' },
    { userId: 'd', status: 'approved' },
  ], businessReceipts: [
    { userId: 'a', status: 'paid', amount: 50005 }, { userId: 'b', status: 'pending', amount: 50000 },
    { userId: 'c', status: 'paid', amount: 50000 }, { userId: 'd', status: 'paid', amount: -100 },
  ] }
  const wallet = businessWallet([row])
  assert.equal(wallet.recordedAmount, 50005)
  assert.equal(wallet.estimatedFee, 5001)
  assert.equal(wallet.estimatedNet, 45004)
  assert.equal(wallet.groups[0].recordedMembers, 1)
  assert.equal(wallet.availableBalance, 0)
  assert.equal(wallet.verifiedHeldBalance, 0)
  assert.equal(businessWallet([]).recordedAmount, 0)
  row.businessReceipts[0].status = 'pending'
  assert.equal(businessWallet([row]).recordedAmount, 0)
})
