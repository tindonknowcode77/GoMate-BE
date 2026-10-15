import { randomUUID } from 'node:crypto'
import { HttpError } from '../../common/http-error.js'

export function validPoint(point) {
  return Boolean(point && typeof point === 'object' && !Array.isArray(point) && Object.keys(point).every(key => ['latitude', 'longitude'].includes(key)) && Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90 && Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180)
}

export function createMapsService(config, fetcher = fetch) {
  // Bounded, short-lived selections bind results to the searching account/session.
  // Search provider is independent from the Mapbox rendering/directions provider.
  const selections = new Map()
  const ready = () => {
    if (!config.mapboxAccessToken) throw new HttpError(503, 'Mapbox chưa được cấu hình. Bạn vẫn có thể nhập địa chỉ và chọn vị trí thủ công.')
  }
  async function fetchJson(url, provider, array = false) {
    let response
    try { response = await fetcher(url.toString(), { signal: AbortSignal.timeout(10000) }) }
    catch { throw new HttpError(504, `${provider} chưa phản hồi. Vui lòng thử lại.`) }
    if (!response.ok) throw new HttpError(response.status === 429 ? 429 : 503, response.status === 429 ? 'Đã đạt giới hạn tra cứu bản đồ. Vui lòng thử lại sau.' : `Không truy cập được ${provider}. Kiểm tra khóa API, quyền truy cập, hạn mức hoặc thử lại sau.`)
    try {
      const data = await response.json()
      if (!data || typeof data !== 'object' || Array.isArray(data) !== array) throw new Error()
      return data
    } catch { throw new HttpError(502, `${provider} trả về dữ liệu không hợp lệ.`) }
  }
  async function request(path, params) {
    ready()
    const url = new URL(path, 'https://api.mapbox.com')
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
    url.searchParams.set('access_token', config.mapboxAccessToken)
    return fetchJson(url, 'Mapbox')
  }
  async function vietmap(path, params, array = false) {
    const url = new URL(path, 'https://maps.vietmap.vn')
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
    url.searchParams.set('apikey', config.vietmapApiKey)
    return fetchJson(url, 'VIETMAP', array)
  }
  function purge() {
    for (const [id, item] of selections) if (item.expires <= Date.now()) selections.delete(id)
    while (selections.size >= 500) selections.delete(selections.keys().next().value)
  }
  return {
    async autocomplete(input, sessionToken, bias, userId = '') {
      if (config.vietmapApiKey) {
        const data = await vietmap('/api/autocomplete/v4', { text: input, display_type: 1, ...(bias ? { focus: `${bias.latitude},${bias.longitude}` } : {}) }, true)
        purge()
        return data.slice(0, 5).flatMap(item => {
          if (typeof item?.ref_id !== 'string' || !item.ref_id || item.ref_id.length > 2048 || typeof item.display !== 'string' || !item.display) return []
          const id = randomUUID(), title = typeof item.name === 'string' && item.name ? item.name : item.display
          while (selections.size >= 500) selections.delete(selections.keys().next().value)
          selections.set(id, { userId, sessionToken, expires: Date.now() + 300000, provider: 'vietmap', refId: item.ref_id, display: item.display, boundaries: Array.isArray(item.boundaries) ? item.boundaries : [] })
          return [{ id, title, text: item.display, subtitle: item.display }]
        })
      }
      const data = await request('/search/geocode/v6/forward', { q: input, country: 'vn', language: 'vi', limit: 5, autocomplete: true, permanent: true, ...(bias ? { proximity: `${bias.longitude},${bias.latitude}` } : {}) })
      if (!Array.isArray(data.features)) throw new HttpError(502, 'Mapbox trả về kết quả tìm kiếm không hợp lệ.')
      purge()
      return data.features.slice(0, 5).flatMap(feature => {
        const props = feature?.properties, coordinates = feature?.geometry?.coordinates
        const point = { latitude: coordinates?.[1], longitude: coordinates?.[0] }
        if (!props || !validPoint(point) || typeof props.full_address !== 'string' || typeof props.name !== 'string') return []
        const id = randomUUID(), context = props.context || {}
        const mapping = { region: 'administrative_area_level_1', district: 'administrative_area_level_2', place: 'locality', locality: 'sublocality_level_1', neighborhood: 'sublocality', country: 'country' }
        const components = Object.entries(mapping).flatMap(([key, type]) => typeof context[key]?.name === 'string' ? [{ name: context[key].name, types: [type] }] : [])
        while (selections.size >= 500) selections.delete(selections.keys().next().value)
        selections.set(id, { userId, sessionToken, expires: Date.now() + 300000, place: { id, provider: 'mapbox', address: props.full_address, point, components, attributions: [] } })
        return [{ id, title: props.name, text: props.full_address, subtitle: props.place_formatted || props.full_address }]
      })
    },
    async details(id, sessionToken, userId = '') {
      const selection = selections.get(id)
      if (!selection || selection.expires <= Date.now() || selection.sessionToken !== sessionToken || selection.userId !== userId) throw new HttpError(404, 'Kết quả tìm kiếm đã hết hạn. Vui lòng tìm lại địa chỉ.')
      if (selection.pending) throw new HttpError(409, 'Đang chọn địa chỉ. Vui lòng chờ một chút.')
      if (selection.provider === 'vietmap') {
        selection.pending = true
        try {
          const data = await vietmap('/api/place/v4', { refid: selection.refId })
          const point = { latitude: data.lat, longitude: data.lng }
          if (!validPoint(point)) throw new HttpError(502, 'Địa điểm VIETMAP chưa có tọa độ hợp lệ. Hãy chọn địa điểm khác.')
          const fields = [['city', 0, 'administrative_area_level_1'], ['district', 1, 'administrative_area_level_2'], ['ward', 2, 'administrative_area_level_3']]
          const components = fields.flatMap(([key, type, mapped]) => {
            const boundary = selection.boundaries.find(item => item?.type === type)
            const name = typeof data[key] === 'string' && data[key] ? data[key] : boundary?.full_name
            return typeof name === 'string' && name ? [{ name, types: [mapped] }] : []
          })
          components.push({ name: 'Việt Nam', types: ['country'] })
          selections.delete(id)
          return { id, provider: 'vietmap', address: typeof data.display === 'string' && data.display ? data.display : selection.display, point, components, attributions: [] }
        } finally { selection.pending = false }
      }
      selections.delete(id)
      return selection.place
    },
    async route(origin, destination, mode) {
      const profile = mode === 'WALK' ? 'walking' : 'driving'
      const data = await request(`/directions/v5/mapbox/${profile}/${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`, { overview: 'full', geometries: 'polyline', alternatives: false, steps: false })
      if (data.code !== 'Ok' && data.code !== 'NoRoute' && data.code !== 'NoSegment') throw new HttpError(502, 'Chưa đọc được tuyến đường từ Mapbox.')
      const route = data.routes?.[0]
      if (!route) throw new HttpError(404, 'Chưa tìm được tuyến đường cho phương tiện này. Thử đổi phương tiện hoặc chọn điểm khác.')
      if (!Number.isFinite(route.distance) || route.distance < 0 || !Number.isFinite(route.duration) || route.duration < 0 || typeof route.geometry !== 'string' || !route.geometry.length || route.geometry.length > 150000 || !/^[?-~]*$/.test(route.geometry)) throw new HttpError(502, 'Chưa đọc được tuyến đường từ Mapbox.')
      return { distanceMeters: route.distance, durationSeconds: route.duration, encodedPolyline: route.geometry }
    },
  }
}
