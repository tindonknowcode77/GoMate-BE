/* global L */
(() => {
  const query = new URLSearchParams(location.search)
  let parentOrigin = location.origin
  try { const candidate = new URL(query.get('parentOrigin')); if (['https:', 'http:'].includes(candidate.protocol)) parentOrigin = candidate.origin } catch { /* Standalone/native map. */ }
  const lat = Number(query.get('lat')), lng = Number(query.get('lng')), radius = Number(query.get('radius'))
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return
  const map = L.map('map').setView([lat, lng], radius > 0 ? 11 : 14)
  const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  }).addTo(map)
  tiles.on('tileerror', () => { document.getElementById('error').textContent = 'Không tải được bản đồ. Kiểm tra mạng và thử lại.' })
  const marker = L.circleMarker([lat, lng], { radius: 9, color: '#fff', weight: 3, fillColor: '#7057ea', fillOpacity: 1 }).addTo(map)
  const circle = radius > 0 && radius <= 500 ? L.circle([lat, lng], { radius: radius * 1000, color: '#7057ea', weight: 1, fillOpacity: 0.08 }).addTo(map) : null
  if (circle) map.fitBounds(circle.getBounds(), { padding: [12, 12] })
  if (query.get('pick') === '1') map.on('click', event => {
    const point = { latitude: event.latlng.lat, longitude: ((event.latlng.lng + 180) % 360 + 360) % 360 - 180 }
    marker.setLatLng([point.latitude, point.longitude]); if (circle) circle.setLatLng([point.latitude, point.longitude])
    const data = { type: 'gomate-map-point', point }
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(data))
    else window.parent.postMessage(data, parentOrigin)
  })
})()
