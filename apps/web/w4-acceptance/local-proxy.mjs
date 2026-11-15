import { createServer, request } from 'node:http';
import { existsSync } from 'node:fs';

createServer((incoming, outgoing) => {
  // Only the local synthetic Messages read may receive a fault.
  if (incoming.method === 'GET' &&
      /^\/api\/v1\/messaging\/me\/conversations\/[^/]+\/messages\?/.test(incoming.url ?? '') &&
      existsSync('test-results/w4-unavailable')) {
    outgoing.writeHead(503, { 'Content-Type': 'application/json' });
    outgoing.end(JSON.stringify({ success: false, error: { code: 'W4_FIXTURE', message: 'Synthetic outage' } }));
    return;
  }
  const upstream = request({
    hostname: '127.0.0.1', port: 8787, path: incoming.url,
    method: incoming.method, headers: incoming.headers,
  }, (response) => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(outgoing);
  });
  upstream.on('error', () => {
    outgoing.writeHead(502);
    outgoing.end();
  });
  incoming.pipe(upstream);
}).listen(8788, '127.0.0.1');
