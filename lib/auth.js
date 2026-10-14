import crypto from 'node:crypto';

const COOKIE_NAME = 'ili_country_access';

function expectedToken() {
  const code = process.env.DASHBOARD_ACCESS_CODE;
  if (!code) return null;
  return crypto.createHash('sha256').update(`ili-dashboard:${code}`).digest('hex');
}

function parseCookies(header='') {
  return Object.fromEntries(String(header).split(';').map(x=>x.trim()).filter(Boolean).map(part=>{
    const i=part.indexOf('=');
    if (i<0) return [part,''];
    const name=part.slice(0,i);
    try {
      return [name,decodeURIComponent(part.slice(i+1))];
    } catch {
      return [name,''];
    }
  }));
}

export function isProtected() {
  return Boolean(process.env.DASHBOARD_ACCESS_CODE);
}

export function hasAccess(req) {
  const token = expectedToken();
  if (!token) return false;
  const cookies = parseCookies(req.headers?.cookie || '');
  const provided = String(cookies[COOKIE_NAME] || '');
  if (provided.length !== token.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(token));
  } catch {
    return false;
  }
}

export function requireAccess(req,res) {
  if (!isProtected()) {
    res.status(503).json({error:'Dashboard access code is not configured'});
    return false;
  }
  if (hasAccess(req)) return true;
  res.status(401).json({error:'Authentication required'});
  return false;
}

export function setAccessCookie(res) {
  const token = expectedToken();
  if (!token) return;
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
}

export function clearAccessCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

export function validateCode(code) {
  const expected = String(process.env.DASHBOARD_ACCESS_CODE || '');
  const received = String(code || '');
  if (!expected) return false;
  if (received.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(received),Buffer.from(expected));
  } catch {
    return false;
  }
}

