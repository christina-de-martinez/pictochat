import { readVid, vidCookie } from './visitor.js';

export { Hub } from './hub.js';

const CANONICAL_HOST = 'pictochat.lol';

// Most static files in public/ are served by Workers Static Assets without running this.
// The page itself runs through here first (see run_worker_first) so it can set the visitor
// cookie and send workers.dev visitors to the real domain.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') return env.HUB.get(env.HUB.idFromName('pictochat')).fetch(request);
    if (url.pathname === '/healthz') return new Response('ok');

    // One address means one set of cookies, so nobody gets counted twice.
    if (url.hostname.endsWith('.workers.dev')) {
      url.hostname = CANONICAL_HOST;
      url.protocol = 'https:';
      url.port = '';
      return Response.redirect(url.toString(), 301);
    }

    const res = await env.ASSETS.fetch(request);
    if (readVid(request) || !(res.headers.get('content-type') || '').includes('text/html')) return res;
    const withCookie = new Response(res.body, res);
    withCookie.headers.append('Set-Cookie', vidCookie(crypto.randomUUID(), url.protocol === 'https:'));
    return withCookie;
  },
};
