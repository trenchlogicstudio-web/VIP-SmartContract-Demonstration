// Copyright (c) 2026 Miloš Petrović (Trench Logic Studio) · SPDX-License-Identifier: MIT
'use strict';

const MAX_BODY_BYTES = 1_000_000;

// Accumulate bytes, then decode once: a chunk may end inside a UTF-8 character.
function readBody(req, res, handle) {
  const reject = (status, error) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error }));
  };
  const local = !process.env.VIP_BIND_HOST || ['127.0.0.1', '::1', 'localhost'].includes(process.env.VIP_BIND_HOST);
  let target;
  try {
    target = new URL('http://' + req.headers.host);
    if (local && !['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname)) throw new Error();
    if (req.method === 'POST' && req.headers.origin && new URL(req.headers.origin).origin !== target.origin) throw new Error();
  } catch {
    req.resume();
    return reject(403, 'FORBIDDEN_ORIGIN');
  }
  const chunks = [];
  let bytes = 0;
  req.on('data', chunk => {
    if (bytes > MAX_BODY_BYTES) return;
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      chunks.length = 0;
      return reject(413, 'PAYLOAD_TOO_LARGE');
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (bytes > MAX_BODY_BYTES) return;
    let body;
    try { body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)); }
    catch { return reject(400, 'BAD_JSON'); }
    handle(body);
  });
}

module.exports = { readBody };
