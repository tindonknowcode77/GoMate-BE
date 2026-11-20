import { EventEmitter } from 'node:events'

// Repositories sharing a database also share their local commit notifications.
// Periodic reconciliation remains necessary when running multiple API processes.
const buses = new WeakMap()
export function realtimeEvents(db) {
  if (!buses.has(db)) buses.set(db, new EventEmitter().setMaxListeners(0))
  return buses.get(db)
}
