export { Hub } from './hub.js';

// Static files in public/ are served by Workers Static Assets before this runs;
// only /ws and unknown paths reach the Worker.
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/ws') return env.HUB.get(env.HUB.idFromName('pictochat')).fetch(request);
    if (pathname === '/healthz') return new Response('ok');
    return env.ASSETS.fetch(request);
  },
};
