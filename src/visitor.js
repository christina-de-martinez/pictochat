// The anonymous visitor id lives in the `pc_vid` cookie, stored the way the page's cookie
// helper writes it (URI-encoded JSON string) so both sides can read it.
export const VID_COOKIE = 'pc_vid';
export const ID_RE = /^[\w-]{8,64}$/;

export function readVid(request) {
  const m = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)pc_vid=([^;]*)/);
  if (!m) return null;
  try {
    const v = JSON.parse(decodeURIComponent(m[1]));
    return typeof v === 'string' && ID_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

// Set from the server so it's a real first-party cookie: Safari caps script-set cookies at
// 7 days and some in-app browsers drop them, which made returning people count as new.
export function vidCookie(vid, secure) {
  return `${VID_COOKIE}=${encodeURIComponent(JSON.stringify(vid))}; Max-Age=31536000; Path=/; SameSite=Lax${secure ? '; Secure' : ''}`;
}
