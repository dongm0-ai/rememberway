// 카카오맵 JS SDK 로드 + 장소 이름 → 좌표 (키워드 검색). 길찾기(도보 경로·교차로)는 아직 미연동.
let loading = null;
export function loadKakao(key) {
  if (!key) return Promise.resolve(null);
  if (window.kakao?.maps?.Map) return Promise.resolve(window.kakao);
  if (loading) return loading;
  loading = new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&libraries=services&autoload=false`;
    s.onload = () => window.kakao.maps.load(() => resolve(window.kakao));
    s.onerror = () => resolve(null);
    document.head.append(s);
  });
  return loading;
}

/** 이름으로 좌표 찾기. near(LatLng)가 있으면 그 주변 5km 우선. 못 찾으면 null */
export function findPlace(kakao, name, near) {
  return new Promise((resolve) => {
    const ps = new kakao.maps.services.Places();
    const opt = near ? { location: near, radius: 5000, size: 3 } : { size: 3 };
    ps.keywordSearch(name, (data, status) => {
      if (status !== kakao.maps.services.Status.OK || !data.length) return resolve(null);
      const d = data[0];
      resolve({ lat: Number(d.y), lng: Number(d.x), address: d.address_name, found_name: d.place_name });
    }, opt);
  });
}

/** 주소(동 단위)로 좌표. 실패하면 키워드 검색으로 한 번 더 */
export async function findHome(kakao, dong) {
  const geo = new kakao.maps.services.Geocoder();
  const byAddr = await new Promise((resolve) => geo.addressSearch(dong, (r, st) => resolve(st === kakao.maps.services.Status.OK && r.length ? { lat: Number(r[0].y), lng: Number(r[0].x) } : null)));
  return byAddr ?? (await findPlace(kakao, dong, null));
}
