import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config/env.js'
import { createMapsService } from '../src/modules/maps/service.js'
import { hashToken, newToken } from '../src/modules/auth/token.js'

const sessionToken = '851ab459-82df-4d43-8f11-e5d45de4ce13', otherSession = '951ab459-82df-4d43-8f11-e5d45de4ce13'
const vietmapKey = 'server-only-vietmap-test-key', mapboxToken = 'pk.mapbox-test'
const point = { latitude: 10.7735, longitude: 106.704 }
const prediction = { ref_id: 'auto:opaque/+?_', name: 'Đường Nguyễn Huệ', display: 'Đường Nguyễn Huệ, Phường Sài Gòn, Thành phố Hồ Chí Minh', boundaries: [{ type: 0, full_name: 'Thành phố Hồ Chí Minh' }, { type: 2, full_name: 'Phường Sài Gòn' }] }
const detail = { name: 'Đường Nguyễn Huệ', display: prediction.display, city: 'Thành phố Hồ Chí Minh', ward: 'Phường Sài Gòn', district: '', lat: point.latitude, lng: point.longitude }

test('VIETMAP lookup stays server-side, binds selections and coexists with Mapbox routes/rendering', async t => {
  const owner = newToken(), other = newToken(), calls = []
  let status = 200, failure = false, malformed = false, empty = false
  const fetcher = async (url, options) => {
    const parsed = new URL(url); calls.push({ url: parsed, options })
    if (failure) throw new Error(vietmapKey)
    const data = parsed.pathname.includes('/autocomplete/') ? empty ? [] : [prediction]
      : parsed.pathname.includes('/place/') ? { ...detail, ...(malformed ? { lat: 100 } : {}) }
      : { code: 'Ok', routes: [{ distance: 1200, duration: 500, geometry: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' }] }
    return new Response(JSON.stringify(status === 200 ? data : { error: vietmapKey }), { status })
  }
  const authRepository = { async findSession(hash) { const id = hash === hashToken(owner) ? 'owner' : hash === hashToken(other) ? 'other' : null; return id ? { user: { id }, expiresAt: new Date(Date.now() + 60000) } : null } }
  const config = readConfig({ MAPBOX_ACCESS_TOKEN: mapboxToken, VIETMAP_API_KEY: vietmapKey })
  const server = createApp(config, { authRepository, mapsOptions: { fetcher } }).listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = async (path, body, token = owner) => {
    const response = await fetch(base + '/api/maps/' + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, data: await response.json() }
  }
  const publicConfig = await request('config', undefined, null)
  assert.equal(publicConfig.data.provider, 'mapbox'); assert.equal(publicConfig.data.searchProvider, 'vietmap'); assert.equal(publicConfig.data.routesEnabled, true); assert.equal(publicConfig.data.placesEnabled, true)
  assert.ok(!JSON.stringify(publicConfig).includes(vietmapKey)); assert.ok(!('vietmapApiKey' in publicConfig.data))
  assert.equal((await request('places/autocomplete', { input: 'Nguyen Hue', sessionToken }, null)).status, 401)
  const search = await request('places/autocomplete', { input: 'Nguyen Hue', sessionToken, bias: point })
  assert.equal(search.status, 200); assert.equal(search.data.items[0].text, prediction.display); assert.notEqual(search.data.items[0].id, prediction.ref_id)
  const upstream = calls.at(-1).url
  assert.equal(upstream.origin, 'https://maps.vietmap.vn'); assert.equal(upstream.pathname, '/api/autocomplete/v4'); assert.equal(upstream.searchParams.get('focus'), '10.7735,106.704'); assert.equal(upstream.searchParams.get('display_type'), '1'); assert.equal(upstream.searchParams.get('apikey'), vietmapKey)
  assert.ok(!calls.some(call => call.url.pathname.includes('/forward')))
  const id = search.data.items[0].id, previous = calls.length
  assert.equal((await request('places/details', { id, sessionToken }, other)).status, 404)
  assert.equal((await request('places/details', { id, sessionToken: otherSession })).status, 404); assert.equal(calls.length, previous)
  status = 423; const denied = await request('places/details', { id, sessionToken }); assert.equal(denied.status, 503); assert.ok(!JSON.stringify(denied).includes(vietmapKey))
  status = 200; malformed = true; assert.equal((await request('places/details', { id, sessionToken })).status, 502); malformed = false
  const selected = await request('places/details', { id, sessionToken })
  assert.equal(selected.status, 200); assert.equal(selected.data.place.provider, 'vietmap'); assert.deepEqual(selected.data.place.point, point)
  assert.deepEqual(selected.data.place.components.find(item => item.types.includes('administrative_area_level_3')), { name: 'Phường Sài Gòn', types: ['administrative_area_level_3'] })
  assert.equal(selected.data.place.components.some(item => item.types.includes('administrative_area_level_2')), false)
  assert.equal(calls.at(-1).url.searchParams.get('refid'), prediction.ref_id); assert.equal(calls.at(-1).url.pathname, '/api/place/v4')
  assert.equal((await request('places/details', { id, sessionToken })).status, 404)
  const route = await request('routes', { origin: point, destination: { latitude: 10.78, longitude: 106.71 }, mode: 'WALK' })
  assert.equal(route.status, 200); assert.equal(calls.at(-1).url.origin, 'https://api.mapbox.com'); assert.equal(calls.at(-1).url.searchParams.get('access_token'), mapboxToken); assert.equal(calls.at(-1).url.searchParams.has('apikey'), false)
  empty = true; assert.deepEqual((await request('places/autocomplete', { input: 'nowhere', sessionToken })).data.items, []); empty = false
  status = 429; assert.equal((await request('places/autocomplete', { input: 'Nguyen Hue', sessionToken })).status, 429)
  status = 200; failure = true; const timeout = await request('places/autocomplete', { input: 'Nguyen Hue', sessionToken }); assert.equal(timeout.status, 504); assert.ok(!JSON.stringify(timeout).includes(vietmapKey))
  const html = await (await fetch(base + '/map.html?lat=10.77&lng=106.7')).text(); assert.ok(html.includes('mapbox-map.js')); assert.ok(!html.includes(vietmapKey))
})

test('VIETMAP lookup works without Mapbox; malformed provider data is rejected', async t => {
  let calls = 0
  const config = readConfig({ VIETMAP_API_KEY: vietmapKey })
  const service = createMapsService(config, async url => { calls++; return new Response(JSON.stringify(url.includes('/autocomplete/') ? [prediction] : detail)) })
  const items = await service.autocomplete('Nguyen Hue', sessionToken, point, 'owner')
  assert.deepEqual((await service.details(items[0].id, sessionToken, 'owner')).point, point)
  assert.equal(calls, 2)
  await assert.rejects(service.route(point, point, 'DRIVE'), error => error.status === 503); assert.equal(calls, 2)
  const invalidSearch = createMapsService(config, async () => new Response(JSON.stringify({ code: 401, message: vietmapKey })))
  await assert.rejects(invalidSearch.autocomplete('Nguyen Hue', sessionToken), error => error.status === 502 && !error.message.includes(vietmapKey))
  const server = createApp(config, { authRepository: { async findSession() { return null } } }).listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const result = await (await fetch(`http://127.0.0.1:${server.address().port}/api/maps/config`)).json()
  assert.equal(result.provider, 'osm'); assert.equal(result.searchProvider, 'vietmap'); assert.equal(result.placesEnabled, true); assert.equal(result.routesEnabled, false)
})
