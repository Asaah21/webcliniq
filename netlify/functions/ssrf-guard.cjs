const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 7000;
const DEFAULT_MAX_BYTES = 400_000;

const BLOCKED_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.google',
  'instance-data',
  'instance-data.ec2.internal',
]);

const BLOCKED_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.localdomain',
];

function stripTrailingDot(hostname) {
  return String(hostname || '').toLowerCase().replace(/\.$/, '');
}

function hostFromUrl(parsed) {
  return stripTrailingDot(parsed.hostname.replace(/^\[|\]$/g, ''));
}

function parseIPv4(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    return n >= 0 && n <= 255 ? n : null;
  });
  if (nums.some((n) => n == null)) return null;
  return nums;
}

function ipv4ToBigInt(parts) {
  return (BigInt(parts[0]) << 24n) + (BigInt(parts[1]) << 16n) + (BigInt(parts[2]) << 8n) + BigInt(parts[3]);
}

function parseIPv6(ip) {
  let value = String(ip).toLowerCase().replace(/^\[|\]$/g, '');
  if (value.includes('%')) return null;

  let ipv4Tail = null;
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    if (lastColon === -1) return null;
    ipv4Tail = parseIPv4(value.slice(lastColon + 1));
    if (!ipv4Tail) return null;
    const high = ((ipv4Tail[0] << 8) | ipv4Tail[1]).toString(16);
    const low = ((ipv4Tail[2] << 8) | ipv4Tail[3]).toString(16);
    value = `${value.slice(0, lastColon)}:${high}:${low}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;

  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const validate = (part) => /^[0-9a-f]{1,4}$/.test(part);
  if (!left.every(validate) || !right.every(validate)) return null;

  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;

  const groups = [
    ...left,
    ...Array(Math.max(0, missing)).fill('0'),
    ...right,
  ].map((part) => Number.parseInt(part, 16));

  if (groups.length !== 8 || groups.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  return groups.reduce((acc, n) => (acc << 16n) + BigInt(n), 0n);
}

function cidrContains(value, base, bits, size) {
  const shift = BigInt(size - bits);
  return (value >> shift) === (base >> shift);
}

function isPublicIPv4(ip) {
  const parts = Array.isArray(ip) ? ip : parseIPv4(ip);
  if (!parts) return false;
  const value = ipv4ToBigInt(parts);
  const inRange = (base, bits) => cidrContains(value, ipv4ToBigInt(parseIPv4(base)), bits, 32);

  return ![
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ].some(([base, bits]) => inRange(base, bits));
}

function ipv6Base(base) {
  const parsed = parseIPv6(base);
  if (parsed == null) throw new Error(`Invalid IPv6 base: ${base}`);
  return parsed;
}

function isIPv4MappedIPv6(value) {
  return cidrContains(value, ipv6Base('::ffff:0:0'), 96, 128);
}

function ipv4FromMappedIPv6(value) {
  const ipv4 = Number(value & 0xffffffffn);
  return [
    (ipv4 >>> 24) & 255,
    (ipv4 >>> 16) & 255,
    (ipv4 >>> 8) & 255,
    ipv4 & 255,
  ];
}

function isPublicIPv6(ip) {
  const value = parseIPv6(ip);
  if (value == null) return false;
  if (isIPv4MappedIPv6(value)) return isPublicIPv4(ipv4FromMappedIPv6(value));

  const inRange = (base, bits) => cidrContains(value, ipv6Base(base), bits, 128);
  return ![
    ['::', 128],
    ['::1', 128],
    ['::', 8],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001::', 23],
    ['2001:2::', 48],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ].some(([base, bits]) => inRange(base, bits));
}

function isPublicIpAddress(address) {
  const version = net.isIP(String(address).replace(/^\[|\]$/g, ''));
  if (version === 4) return isPublicIPv4(address);
  if (version === 6) return isPublicIPv6(address);
  return false;
}

function validatePublicHttpUrl(input) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('Invalid URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS URLs are allowed.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Credentials in URLs are not allowed.');
  }

  const host = hostFromUrl(parsed);
  if (!host) throw new Error('URL host is required.');
  if (host === 'localhost' || BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new Error('Host is not public.');
  }

  const ipVersion = net.isIP(host);
  if (ipVersion && !isPublicIpAddress(host)) {
    throw new Error('IP address is not public.');
  }
  if (!ipVersion && !host.includes('.')) {
    throw new Error('Host must be a public DNS name.');
  }

  parsed.hostname = host;
  return parsed;
}

async function resolvePublicHostname(hostname, resolver = dns.lookup) {
  const host = stripTrailingDot(hostname.replace(/^\[|\]$/g, ''));
  if (net.isIP(host)) {
    if (!isPublicIpAddress(host)) throw new Error('IP address is not public.');
    return [{ address: host, family: net.isIP(host) }];
  }

  const answers = await resolver(host, { all: true, verbatim: true });
  const records = Array.isArray(answers) ? answers : [answers];
  if (!records.length) throw new Error('Host did not resolve.');

  for (const record of records) {
    if (!record || !isPublicIpAddress(record.address)) {
      throw new Error('Host resolves to a non-public address.');
    }
  }

  return records.map((record) => ({ address: record.address, family: record.family || net.isIP(record.address) }));
}

function responseHeaders(rawHeaders) {
  const lower = {};
  for (const [key, value] of Object.entries(rawHeaders || {})) {
    lower[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value || '');
  }
  return {
    get(name) {
      return lower[String(name).toLowerCase()] || null;
    },
  };
}

function requestWithPinnedLookup(parsed, resolved, options) {
  const {
    method = 'GET',
    headers = {},
    timeout = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    createConnection,
  } = options;
  const first = resolved[0];
  const client = parsed.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const req = client.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers,
      lookup(_hostname, _opts, callback) {
        callback(null, first.address, first.family);
      },
      createConnection,
    }, (res) => {
      const chunks = [];
      let size = 0;

      res.on('data', (chunk) => {
        if (method === 'HEAD' || maxBytes === 0) return;
        size += chunk.length;
        if (size > maxBytes) {
          finishReject(new Error('Response body is too large.'));
          req.destroy(new Error('Response body is too large.'));
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        if (settled) return;
        settled = true;
        const body = Buffer.concat(chunks);
        resolve({
          status: res.statusCode || 0,
          ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
          url: parsed.href,
          headers: responseHeaders(res.headers),
          async text() {
            return body.toString('utf8');
          },
        });
      });
    });

    req.setTimeout(timeout, () => req.destroy(new Error('Request timed out.')));
    req.on('error', finishReject);
    req.end();
  });
}

async function fetchPublicHttpUrl(input, options = {}) {
  const {
    resolver,
    maxRedirects = MAX_REDIRECTS,
    requireContentType,
  } = options;

  let parsed = validatePublicHttpUrl(input);
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const resolved = await resolvePublicHostname(parsed.hostname, resolver);
    const response = await requestWithPinnedLookup(parsed, resolved, options);
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      if (hop === maxRedirects) throw new Error('Too many redirects.');
      parsed = validatePublicHttpUrl(new URL(location, parsed.href).href);
      continue;
    }

    if (requireContentType) {
      const contentType = response.headers.get('content-type') || '';
      if (!requireContentType.test(contentType)) {
        throw new Error(`Unexpected content type: ${contentType || 'missing'}.`);
      }
    }

    return response;
  }

  throw new Error('Too many redirects.');
}

module.exports = {
  fetchPublicHttpUrl,
  isPublicIpAddress,
  isPublicIPv4,
  isPublicIPv6,
  resolvePublicHostname,
  validatePublicHttpUrl,
};
