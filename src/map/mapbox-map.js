/* global mapboxgl */
(() => {
  const query = new URLSearchParams(location.search), error = document.getElementById('error')
  let parentOrigin = location.origin, map, originMarker, pendingRoute = null, loaded = false
  try { const candidate = new URL(query.get('parentOrigin')); if (['https:', 'http:'].includes(candidate.protocol)) parentOrigin = candidate.origin } catch { /* Standalone/native map. */ }
  const valid = point => point && Number.isFinite(point.latitude) && Number.isFinite(point.longitude) && Math.abs(point.latitude) <= 90 && Math.abs(point.longitude) <= 180
  const lngLat = point => [point.longitude, point.latitude]
  function decode(encoded) {
    let index = 0, lat = 0, lng = 0
    const points = []
    function number() {
      let result = 0, shift = 0, byte
      do { if (index >= encoded.length || shift > 30) throw new Error(); byte = encoded.charCodeAt(index++) - 63; if (byte < 0 || byte > 63) throw new Error(); result |= (byte & 31) << shift; shift += 5 } while (byte >= 32)
      return result & 1 ? ~(result >> 1) : result >> 1
    }
    while (index < encoded.length) { lat += number(); lng += number(); const point = { latitude: lat / 1e5, longitude: lng / 1e5 }; if (!valid(point)) throw new Error(); points.push(lngLat(point)) }
    return points
  }
  function applyRoute(route) {
    pendingRoute = route
    if (!loaded) return
    if (map.getLayer('gomate-route')) map.removeLayer('gomate-route')
    if (map.getSource('gomate-route')) map.removeSource('gomate-route')
    originMarker?.remove(); originMarker = null
    if (!route || !valid(route.origin) || typeof route.encodedPolyline !== 'string' || route.encodedPolyline.length > 150000) return
    try {
      const path = decode(route.encodedPolyline)
      if (path.length < 2) return
      map.addSource('gomate-route', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: path } } })
      map.addLayer({ id: 'gomate-route', type: 'line', source: 'gomate-route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#7057EA', 'line-width': 5, 'line-opacity': 0.85 } })
      originMarker = new mapboxgl.Marker({ color: '#26A69A' }).setLngLat(lngLat(route.origin)).addTo(map)
      const bounds = new mapboxgl.LngLatBounds(); path.forEach(point => bounds.extend(point)); map.fitBounds(bounds, { padding: 35, maxZoom: 15, duration: 0 })
    } catch { error.textContent = 'Chưa hiển thị được tuyến đường. Vui lòng thử lại.' }
  }
  function receive(event) {
    let data = event.data
    if (typeof data === 'string') { try { data = JSON.parse(data) } catch { return } }
    if (!window.ReactNativeWebView && (event.source !== window.parent || event.origin !== parentOrigin)) return
    if (data?.type === 'gomate-map-route') applyRoute(data.route)
  }
  window.addEventListener('message', receive); document.addEventListener('message', receive)
  function circle(point, radius) {
    const coordinates = [], lat = point.latitude * Math.PI / 180, lon = point.longitude * Math.PI / 180, distance = radius / 6371
    for (let i = 0; i <= 64; i++) {
      const angle = i * Math.PI / 32, y = Math.asin(Math.sin(lat) * Math.cos(distance) + Math.cos(lat) * Math.sin(distance) * Math.cos(angle))
      const x = lon + Math.atan2(Math.sin(angle) * Math.sin(distance) * Math.cos(lat), Math.cos(distance) - Math.sin(lat) * Math.sin(y))
      coordinates.push([x * 180 / Math.PI, y * 180 / Math.PI])
    }
    return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coordinates] } }
  }
  async function init() {
    const point = { latitude: Number(query.get('lat')), longitude: Number(query.get('lng')) }
    if (!query.has('lat') || !query.has('lng') || !valid(point)) { error.textContent = 'Vị trí không hợp lệ.'; return }
    try {
      const response = await fetch('/api/maps/config'), config = await response.json()
      if (!response.ok || !config.accessToken || typeof mapboxgl === 'undefined') throw new Error()
      map = new mapboxgl.Map({ container: 'map', accessToken: config.accessToken, style: 'mapbox://styles/mapbox/streets-v12', center: lngLat(point), zoom: 14, cooperativeGestures: true, attributionControl: true })
      map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right')
      const marker = new mapboxgl.Marker({ color: '#7057EA', draggable: query.get('pick') === '1' }).setLngLat(lngLat(point)).addTo(map)
      const radius = Number(query.get('radius'))
      let selected = point
      function choose(location) {
        const next = { latitude: location.lat, longitude: location.lng }
        if (!valid(next)) return
        selected = next; marker.setLngLat(lngLat(next)); applyRoute(null)
        if (map.getSource('gomate-radius')) map.getSource('gomate-radius').setData(circle(next, radius))
        const data = { type: 'gomate-map-point', point: next }
        if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(data)); else window.parent.postMessage(data, parentOrigin)
      }
      if (query.get('pick') === '1') { map.on('click', event => choose(event.lngLat)); marker.on('dragend', () => choose(marker.getLngLat())) }
      const timeout = setTimeout(() => { if (!loaded) error.textContent = 'Bản đồ tải chậm. Kiểm tra kết nối hoặc tải lại.' }, 20000)
      map.on('error', () => { error.textContent = 'Chưa tải được một phần bản đồ Mapbox. Kiểm tra kết nối hoặc quyền API.' })
      map.on('load', () => {
        loaded = true; clearTimeout(timeout); error.textContent = ''
        if (radius > 0 && radius <= 500) {
          const data = circle(selected, radius)
          map.addSource('gomate-radius', { type: 'geojson', data })
          map.addLayer({ id: 'gomate-radius-fill', type: 'fill', source: 'gomate-radius', paint: { 'fill-color': '#7057EA', 'fill-opacity': 0.1 } })
          map.addLayer({ id: 'gomate-radius-border', type: 'line', source: 'gomate-radius', paint: { 'line-color': '#7057EA', 'line-width': 1 } })
          const bounds = new mapboxgl.LngLatBounds(); data.geometry.coordinates[0].forEach(point => bounds.extend(point)); map.fitBounds(bounds, { padding: 20, duration: 0 })
        }
        applyRoute(pendingRoute)
      })
      window.addEventListener('pagehide', () => { clearTimeout(timeout); map.remove() }, { once: true })
    } catch { error.textContent = 'Không tải được Mapbox. Kiểm tra kết nối và thử lại.' }
  }
  void init()
})()
