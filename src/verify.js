// Check-in verification helpers: GPS geofence and venue network (public IP).

export function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Find the nearest site. A reading counts as inside when the site's radius
 * overlaps the GPS uncertainty circle (accuracy is capped so a very vague
 * fix can't pass from far away).
 */
export function checkGeofence(lat, lng, accuracy, sites) {
  let best = null;
  for (const site of sites) {
    const distance = distanceMeters(lat, lng, site.lat, site.lng);
    if (!best || distance - site.radius_m < best.distance - best.site.radius_m) best = { site, distance };
  }
  if (!best) return null;
  const slack = Math.min(Math.max(Number(accuracy) || 0, 0), 100);
  return { site: best.site, distance: Math.round(best.distance), inside: best.distance - slack <= best.site.radius_m };
}

export function normalizeIp(ip) {
  if (!ip) return '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function ipv4ToInt(ip) {
  const p = ip.split('.');
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || +x > 255)) return null;
  return ((+p[0] << 24) | (+p[1] << 16) | (+p[2] << 8) | +p[3]) >>> 0;
}

export function parseAllowList(text) {
  return String(text || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

/** Entries can be an exact IP, an IPv4 CIDR (203.0.113.0/24) or a prefix ending in * (2001:db8:1:2:*). */
export function ipAllowed(ip, entries) {
  ip = normalizeIp(ip);
  for (const entry of entries) {
    if (entry.endsWith('*')) {
      if (ip.toLowerCase().startsWith(entry.slice(0, -1).toLowerCase())) return true;
    } else if (entry.includes('/')) {
      const [base, bitsStr] = entry.split('/');
      const bits = Number(bitsStr);
      const a = ipv4ToInt(ip);
      const b = ipv4ToInt(base);
      if (a === null || b === null || !(bits >= 0 && bits <= 32)) continue;
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      if ((a & mask) === (b & mask)) return true;
    } else if (normalizeIp(entry).toLowerCase() === ip.toLowerCase()) {
      return true;
    }
  }
  return false;
}

