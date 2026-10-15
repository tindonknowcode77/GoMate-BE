import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { createMapsService } from '../src/modules/maps/service.js'
import { hashToken, newToken } from '../src/modules/auth/token.js'

const sessionToken = '851ab459-82df-4d43-8f11-e5d45de4ce13'
const origin = { latitude: 10.77, longitude: 106.7 }, destination = { latitude: 10.79, longitude: 106.72 }
const accessToken = 'pk.mapbox-test-public'
export const feature = { geometry: { type: 'Point', coordinates: [106.72, 10.79] }, properties: { name: '12 Test', full_address: '12 Test, Hồ Chí Minh, Việt Nam', place_formatted: 'Hồ Chí Minh, Việt Nam', context: { region: { name: 'Hồ Chí Minh' }, country: { name: 'Việt Nam' } } } }

test('Mapbox APIs authenticate, validate, bind permanent selections, normalize routes and sanitize errors', async t => {
  const token = newToken(), calls = []
  let status = 200, failure = false, noRoute = false
  const fetcher = async (url, options) => {
    calls.push({ url: new URL(url), options }); if (failure) throw new Error(accessToken)
    const data = url.includes('/forward') ? { features: [feature] } : { code: noRoute ? 'NoRoute' : 'Ok', routes: noRoute ? [] : [{ distance: 4200, duration: 900, geometry: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' }] }
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
  }
  const config = readConfig({ MAPBOX_ACCESS_TOKEN: accessToken })
  const authRepository = { async findSession(value) { return value === hashToken(token) ? { user: { id: 'maps-user', name: 'Maps user', email: 'maps@example.com' }, expiresAt: new Date(Date.now() + 60000) } : null } }
  const server = createApp(config, { authRepository, mapsOptions: { fetcher } }).listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = async (path, body, auth = true) => {
    const response = await fetch(base + '/api/maps' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json(), headers: response.headers }
  }
  const available = await request('/config', undefined, false)
  assert.equal(available.body.provider, 'mapbox'); assert.equal(available.body.accessToken, accessToken); assert.equal(available.body.placesEnabled, true); assert.equal(available.body.routesEnabled, true); assert.equal(available.headers.get('cache-control'), 'no-store')
  for (const [path, body] of [['/places/autocomplete', { input: 'address', sessionToken }], ['/places/details', { id: 'unknown', sessionToken }], ['/routes', { origin, destination, mode: 'DRIVE' }]]) assert.equal((await request(path, body, false)).status, 401)
  const beforeInvalid = calls.length
  for (const body of [{ input: 'a', sessionToken }, { input: 'valid', sessionToken: 'bad' }, { input: 'address', sessionToken, bias: { latitude: 91, longitude: 0 } }, { input: 'address', sessionToken, url: 'https://evil.example' }, { input: 'invalid;address', sessionToken }, { input: 'word '.repeat(21), sessionToken }]) assert.equal((await request('/places/autocomplete', body)).status, 400)
  assert.equal((await request('/places/details', { id: '../secrets', sessionToken })).status, 400)
  assert.equal((await request('/routes', { origin, destination, mode: 'FLY' })).status, 400)
  assert.equal((await request('/routes', { origin: { ...origin, apiKey: accessToken }, destination, mode: 'DRIVE' })).status, 400)
  assert.equal(calls.length, beforeInvalid)
  const predictions = await request('/places/autocomplete', { input: '12 Test', sessionToken, bias: origin })
  assert.equal(predictions.status, 200); assert.equal(predictions.body.items[0].title, '12 Test')
  const params = calls.at(-1).url.searchParams
  assert.equal(params.get('country'), 'vn'); assert.equal(params.get('language'), 'vi'); assert.equal(params.get('permanent'), 'true'); assert.equal(params.get('proximity'), '106.7,10.77'); assert.equal(params.get('access_token'), accessToken)
  const id = predictions.body.items[0].id, callCount = calls.length
  assert.equal((await request('/places/details', { id, sessionToken: '951ab459-82df-4d43-8f11-e5d45de4ce13' })).status, 404)
  const place = await request('/places/details', { id, sessionToken })
  assert.equal(place.status, 200); assert.deepEqual(place.body.place.point, destination); assert.equal(calls.length, callCount)
  assert.equal((await request('/places/details', { id, sessionToken })).status, 404)
  const route = await request('/routes', { origin, destination, mode: 'DRIVE' })
  assert.equal(route.status, 200); assert.equal(route.body.route.distanceMeters, 4200); assert.equal(route.body.route.durationSeconds, 900)
  assert.match(calls.at(-1).url.pathname, /driving\/106.7,10.77;106.72,10.79/); assert.equal(calls.at(-1).url.searchParams.get('geometries'), 'polyline')
  assert.equal((await request('/routes', { origin, destination, mode: 'WALK' })).status, 200); assert.match(calls.at(-1).url.pathname, /walking/)
  noRoute = true; assert.equal((await request('/routes', { origin, destination, mode: 'WALK' })).status, 404); noRoute = false
  status = 403; const denied = await request('/places/autocomplete', { input: 'address', sessionToken }); assert.equal(denied.status, 503); assert.ok(!JSON.stringify(denied.body).includes(accessToken))
  status = 429; assert.equal((await request('/places/autocomplete', { input: 'address', sessionToken })).status, 429)
  status = 200; failure = true; assert.equal((await request('/places/autocomplete', { input: 'address', sessionToken })).status, 504)
  const html = await fetch(base + '/map.html?lat=10.77&lng=106.7')
  assert.match(await html.text(), /mapbox-map.js/); assert.equal(html.headers.get('x-frame-options'), null); assert.match(html.headers.get('content-security-policy'), /api.mapbox.com/); assert.ok(!html.headers.get('content-security-policy').includes('googleapis'))
  for (let index = 0; index < 12; index++) await request('/routes', { origin, destination, mode: 'DRIVE' })
  assert.equal((await request('/routes', { origin, destination, mode: 'DRIVE' })).status, 429)
})

test('unconfigured/secret tokens fail before upstream requests; selections belong to their account', async () => {
  let called = false
  for (const env of [{}, { MAPBOX_ACCESS_TOKEN: 'sk.secret-token' }]) {
    const service = createMapsService(readConfig(env), async () => { called = true; throw new Error() })
    await assert.rejects(service.autocomplete('address', sessionToken), error => error.status === 503)
  }
  assert.equal(called, false)
  const service = createMapsService(readConfig({ MAPBOX_ACCESS_TOKEN: accessToken }), async () => new Response(JSON.stringify({ features: [feature] })))
  const items = await service.autocomplete('12 Test', sessionToken, origin, 'owner')
  await assert.rejects(service.details(items[0].id, sessionToken, 'other'), error => error.status === 404)
  assert.deepEqual((await service.details(items[0].id, sessionToken, 'owner')).point, destination)
  const bad = createMapsService(readConfig({ MAPBOX_ACCESS_TOKEN: accessToken }), async () => new Response(JSON.stringify({ code: 'Ok', routes: [{ distance: -1, duration: 1, geometry: 'abc' }] })))
  await assert.rejects(bad.route(origin, destination, 'DRIVE'), error => error.status === 502)
  const malformed = createMapsService(readConfig({ MAPBOX_ACCESS_TOKEN: accessToken }), async () => new Response('null'))
  await assert.rejects(malformed.autocomplete('address', sessionToken), error => error.status === 502)
})

test('without a Mapbox token the map document retains the OSM fallback', async t => {
  const server = createApp(readConfig({ GOOGLE_MAPS_BROWSER_KEY: 'obsolete-google-key' })).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/map.html?lat=10.77&lng=106.7`)
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.match(html, /leaflet.js/)
  assert.ok(!html.includes('mapbox-gl') && !html.includes('google-map'))
  assert.ok(!response.headers.get('content-security-policy').includes('api.mapbox.com'))
})
