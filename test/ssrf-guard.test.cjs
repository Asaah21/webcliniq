const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const test = require('node:test');

const {
  fetchPublicHttpUrl,
  isPublicIpAddress,
  resolvePublicHostname,
  validatePublicHttpUrl,
} = require('../netlify/functions/ssrf-guard.cjs');

function rejectsUrl(url) {
  assert.throws(() => validatePublicHttpUrl(url));
}

function acceptsUrl(url) {
  assert.equal(validatePublicHttpUrl(url).href, new URL(url).href);
}

test('URL validation allows only public http and https URLs without credentials', () => {
  acceptsUrl('https://example.com/');
  acceptsUrl('http://www.example.com/path?q=1');

  rejectsUrl('ftp://example.com/');
  rejectsUrl('file:///etc/passwd');
  rejectsUrl('https://user@example.com/');
  rejectsUrl('https://user:pass@example.com/');
  rejectsUrl('http://localhost/');
  rejectsUrl('http://app.localhost/');
  rejectsUrl('http://service.local/');
  rejectsUrl('http://metadata.google.internal/');
  rejectsUrl('http://metadata/');
});

test('URL validation rejects private, loopback, link-local, multicast, reserved, and metadata IPv4 addresses', () => {
  [
    'http://0.0.0.0/',
    'http://10.0.0.1/',
    'http://100.64.0.1/',
    'http://127.0.0.1/',
    'http://169.254.169.254/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://192.0.2.10/',
    'http://198.18.0.1/',
    'http://198.51.100.1/',
    'http://203.0.113.1/',
    'http://224.0.0.1/',
    'http://240.0.0.1/',
  ].forEach(rejectsUrl);
});

test('URL validation rejects private, loopback, link-local, multicast, and reserved IPv6 addresses', () => {
  [
    'http://[::]/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[64:ff9b::1]/',
    'http://[100::1]/',
    'http://[2001:db8::1]/',
    'http://[fc00::1]/',
    'http://[fd12:3456::1]/',
    'http://[fe80::1]/',
    'http://[ff02::1]/',
  ].forEach(rejectsUrl);
});

test('encoded and unusual localhost formats are rejected by URL normalization', () => {
  [
    'http://2130706433/',
    'http://0177.0.0.1/',
    'http://0x7f.0.0.1/',
    'http://%31%32%37.0.0.1/',
    'http://[::ffff:7f00:1]/',
  ].forEach(rejectsUrl);
});

test('DNS validation rejects a hostname if any resolved address is non-public', async () => {
  await assert.rejects(
    () => resolvePublicHostname('example.com', async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.2', family: 4 },
    ]),
    /non-public/
  );

  await assert.rejects(
    () => resolvePublicHostname('example.com', async () => [
      { address: '2606:4700:4700::1111', family: 6 },
      { address: 'fd00::1', family: 6 },
    ]),
    /non-public/
  );
});

test('DNS validation accepts normal public IPv4 and IPv6 answers', async () => {
  const records = await resolvePublicHostname('example.com', async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ]);
  assert.equal(records.length, 2);
  assert.equal(isPublicIpAddress('93.184.216.34'), true);
  assert.equal(isPublicIpAddress('2606:4700:4700::1111'), true);
});

test('fetch rejects DNS rebinding to private addresses before connecting', async () => {
  await assert.rejects(
    () => fetchPublicHttpUrl('http://public.test/', {
      resolver: async () => [{ address: '10.0.0.10', family: 4 }],
    }),
    /non-public/
  );
});

test('fetch manually rejects redirects to private addresses', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: 'http://127.0.0.1/private' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>ok</h1>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  await assert.rejects(
    () => fetchPublicHttpUrl(`http://public.test:${port}/redirect`, {
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      createConnection: () => net.createConnection({ host: '127.0.0.1', port }),
    }),
    /not public|Host/
  );
});

test('fetch supports normal public HTML responses with pinned lookup', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Public</title><h1>Public site</h1>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const response = await fetchPublicHttpUrl(`http://public.test:${port}/`, {
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    createConnection: () => net.createConnection({ host: '127.0.0.1', port }),
    requireContentType: /\btext\/html\b/i,
  });
  assert.equal(response.ok, true);
  assert.match(await response.text(), /Public site/);
});

test('fetch enforces content type and response size limits', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('x'.repeat(1024));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const common = {
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    createConnection: () => net.createConnection({ host: '127.0.0.1', port }),
  };

  await assert.rejects(
    () => fetchPublicHttpUrl(`http://public.test:${port}/json`, {
      ...common,
      requireContentType: /\btext\/html\b/i,
    }),
    /Unexpected content type/
  );

  await assert.rejects(
    () => fetchPublicHttpUrl(`http://public.test:${port}/large`, {
      ...common,
      maxBytes: 10,
    }),
    /too large/
  );
});
