// server/middleware/compress.js
// Lightweight zero-dependency gzip/deflate compression for HTML, JSON, SVG, and text assets.
// Skips SSE / chat streams and already-compressed binaries (.apk, .ipa, .png, .ico).
const zlib = require('zlib');

const SKIP_EXTENSIONS = /\.(apk|ipa|png|jpg|jpeg|webp|gif|ico|woff2?|mp3|mp4|zip|gz)$/i;
const COMPRESSIBLE_TYPES = /(text\/|application\/javascript|application\/json|application\/manifest\+json|image\/svg\+xml)/i;

function compressionMiddleware(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (SKIP_EXTENSIONS.test(req.path)) return next();
  if (req.path.startsWith('/api/chat/send') || req.path.startsWith('/chat/send')) return next();

  const acceptEncoding = String(req.headers['accept-encoding'] || '');
  const useGzip = /\bgzip\b/i.test(acceptEncoding);
  if (!useGzip) return next();

  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  const chunks = [];
  let bypassed = false;

  function shouldCompress() {
    if (res.headersSent) return false;
    if (res.getHeader('Content-Encoding')) return false;
    const cType = String(res.getHeader('Content-Type') || '');
    if (cType.includes('text/event-stream')) return false;
    if (cType && !COMPRESSIBLE_TYPES.test(cType)) return false;
    return true;
  }

  res.write = function (chunk, encoding, cb) {
    if (bypassed) return origWrite(chunk, encoding, cb);
    const cType = String(res.getHeader('Content-Type') || '');
    if (cType.includes('text/event-stream')) {
      bypassed = true;
      for (const c of chunks) origWrite(c);
      chunks.length = 0;
      return origWrite(chunk, encoding, cb);
    }
    if (chunk !== undefined && chunk !== null) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    }
    if (typeof cb === 'function') cb();
    return true;
  };

  res.end = function (chunk, encoding, cb) {
    if (typeof chunk === 'function') {
      cb = chunk;
      chunk = null;
    } else if (typeof encoding === 'function') {
      cb = encoding;
      encoding = undefined;
    }

    if (bypassed) return origEnd(chunk, encoding, cb);
    if (chunk !== undefined && chunk !== null) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    }

    const raw = chunks.length ? Buffer.concat(chunks) : null;
    if (
      req.method === 'HEAD' ||
      res.statusCode === 204 ||
      res.statusCode === 304 ||
      !raw ||
      raw.length < 1024 ||
      !shouldCompress()
    ) {
      res.write = origWrite;
      res.end = origEnd;
      return raw && raw.length ? origEnd(raw, cb) : origEnd(cb);
    }

    zlib.gzip(raw, { level: 6 }, (err, compressed) => {
      res.write = origWrite;
      res.end = origEnd;
      if (err) {
        return raw.length ? origEnd(raw, cb) : origEnd(cb);
      }
      res.removeHeader('Content-Length');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      return origEnd(compressed, cb);
    });
  };

  next();
}

module.exports = { compressionMiddleware };
