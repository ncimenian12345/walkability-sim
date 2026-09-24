// Vercel Routing Middleware: password-protects the whole site with HTTP Basic Auth.
// Runs before every request (pages, scripts, data) on Vercel, free on the Hobby plan.
//
// Set in Vercel → Project → Settings → Environment Variables:
//   SITE_PASSWORD  (required)  the password visitors must enter
//   SITE_USER      (optional)  username; if unset, any username is accepted
// Then redeploy. If SITE_PASSWORD is missing the site stays locked (fails closed).

const REALM = 'Walkability Sim';

function unauthorized(message = 'Password required') {
  return new Response(message, {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'Cache-Control': 'no-store',
    },
  });
}

// Compare without leaking the match length through timing
function safeEqual(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export default function middleware(request) {
  const password = process.env.SITE_PASSWORD;
  const user = process.env.SITE_USER;
  if (!password) {
    return new Response('Site locked: set the SITE_PASSWORD environment variable in Vercel and redeploy.', { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }

  const header = request.headers.get('authorization') || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return unauthorized();

  let decoded = '';
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
  } catch {
    return unauthorized();
  }
  const i = decoded.indexOf(':');
  const givenUser = i >= 0 ? decoded.slice(0, i) : '';
  const givenPass = i >= 0 ? decoded.slice(i + 1) : decoded;

  const userOk = user ? safeEqual(givenUser, user) : true;
  if (!userOk || !safeEqual(givenPass, password)) return unauthorized('Wrong password');

  // Returning nothing lets the request continue to the site.
  return undefined;
}
