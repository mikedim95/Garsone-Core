import { FastifyRequest, FastifyReply } from 'fastify';

const IS_PROD = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);
const ALLOWED_IPS_RAW = (process.env.ALLOWED_IPS || '127.0.0.1,::1,::ffff:127.0.0.1')
  .split(',')
  .map(ip => ip.trim())
  .filter(Boolean);
const ALLOW_ALL = ALLOWED_IPS_RAW.includes('*') || (IS_PROD && !process.env.ALLOWED_IPS);

function normalizeIp(ip: string) {
  // Convert ::ffff:192.168.1.10 -> 192.168.1.10
  const v4mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return v4mapped ? v4mapped[1] : ip;
}

function ipToInt(ip: string) {
  return ip.split('.').map(Number).reduce((acc, v) => (acc << 8) + (v & 255), 0) >>> 0;
}

function inCidr(ip: string, cidr: string) {
  // IPv4 only CIDR check
  const [range, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr || '32', 10);
  if (!range || Number.isNaN(bits)) return false;
  try {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipToInt(ip) & mask) === (ipToInt(range) & mask);
  } catch {
    return false;
  }
}

const ALLOWED = ALLOWED_IPS_RAW.map((entry) => ({ entry, isCidr: entry.includes('/') }));

export async function ipWhitelistMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const clientIp = request.headers['x-forwarded-for'] 
    ? (request.headers['x-forwarded-for'] as string).split(',')[0].trim()
    : request.ip;

  if (ALLOW_ALL) {
    return; // allow all
  }

  const ip = normalizeIp(clientIp);
  const allowed = ALLOWED.some(({ entry, isCidr }) =>
    isCidr ? inCidr(ip, entry) : normalizeIp(entry) === ip
  );

  if (!allowed) {
    return reply.status(403).send({ error: 'Access denied: IP not whitelisted' });
  }
}
