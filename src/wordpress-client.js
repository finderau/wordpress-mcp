/**
 * WordPress REST API client.
 *
 * Wraps fetch with Basic Auth (Application Passwords), retry on 429,
 * and optional path prefix for multisite subdirectory installs.
 */

// Maximum response body size (5MB) to prevent OOM from misbehaving servers
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
// Default request timeout (30 seconds)
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Read a response body with a size limit. Throws if the body exceeds maxBytes.
 */
async function readResponseBody(response, maxBytes = MAX_RESPONSE_SIZE) {
  const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
  if (contentLength > maxBytes) {
    throw new Error(`Response too large (${contentLength} bytes, max ${maxBytes})`);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    // Fallback: read as text but enforce size limit
    const text = await response.text();
    if (text.length > maxBytes) {
      throw new Error(`Response too large (exceeded ${maxBytes} bytes)`);
    }
    return text;
  }
  const chunks = [];
  let totalSize = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalSize += value.length;
    if (totalSize > maxBytes) {
      reader.cancel();
      throw new Error(`Response too large (exceeded ${maxBytes} bytes)`);
    }
    chunks.push(value);
  }
  const combined = Buffer.concat(chunks);
  return combined.toString('utf-8');
}

export class WordPressClient {
  /**
   * @param {string} baseUrl - Site base URL (e.g. "https://qa1.finder.com.au")
   * @param {string} username - WordPress username
   * @param {string} appPassword - Application Password
   * @param {object} [options]
   * @param {string} [options.pathPrefix] - Path prefix for multisite subdirectory installs
   */
  constructor(baseUrl, username, appPassword, options = {}) {
    const cleanUrl = baseUrl.replace(/\/+$/, '');
    if (!cleanUrl.startsWith('https://')) {
      throw new Error('WordPress client requires HTTPS');
    }
    this.baseUrl = cleanUrl;
    this.authHeader = 'Basic ' + Buffer.from(`${username}:${appPassword}`).toString('base64');
    this.pathPrefix = options.pathPrefix || '';
  }

  /**
   * Make a request to the WP REST API.
   * @param {string} method - HTTP method
   * @param {string} endpoint - API endpoint (e.g. "/posts/123")
   * @param {object|null} [body] - Request body (JSON-serialisable)
   * @param {object} [extraHeaders] - Additional headers
   * @returns {Promise<object>} Parsed JSON response
   */
  async request(method, endpoint, body = null, extraHeaders = {}) {
    const url = `${this.baseUrl}${this.pathPrefix}/wp-json/wp/v2${endpoint}`;

    const headers = {
      'Authorization': this.authHeader,
      'Accept': 'application/json',
      ...extraHeaders,
    };

    if (body && method !== 'GET') {
      headers['Content-Type'] = 'application/json';
    }

    const fetchBody = (body && method !== 'GET') ? JSON.stringify(body) : undefined;

    let response;
    let retries = 0;
    const maxRetries = 2;

    while (true) {
      // Fresh timeout per attempt — previous signal expires during Retry-After waits
      const options = { method, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
      if (fetchBody) options.body = fetchBody;
      response = await fetch(url, options);

      // Retry on 429 with backoff (cap wait to prevent DoS via large Retry-After)
      if (response.status === 429 && retries < maxRetries) {
        const retryAfter = Math.min(parseInt(response.headers.get('Retry-After') || '2', 10) || 2, 30);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        retries++;
        continue;
      }
      break;
    }

    if (!response.ok) {
      const text = await readResponseBody(response, 64 * 1024); // 64KB max for error bodies
      let detail;
      try {
        const json = JSON.parse(text);
        detail = json.code || null;
      } catch { /* ignore */ }
      throw new Error(`WordPress API error (${response.status}): ${detail || 'request failed'}`);
    }

    // DELETE with force=true returns the deleted object; some endpoints return 204
    if (response.status === 204) {
      return { deleted: true };
    }

    const body_text = await readResponseBody(response);
    return JSON.parse(body_text);
  }

  async get(endpoint) {
    return this.request('GET', endpoint);
  }

  async post(endpoint, body) {
    return this.request('POST', endpoint, body);
  }

  async del(endpoint) {
    return this.request('DELETE', endpoint);
  }

  /**
   * Fetch the WP REST API index (/wp-json).
   * @returns {Promise<object>} Site index data
   */
  async getSiteIndex() {
    const url = `${this.baseUrl}${this.pathPrefix}/wp-json`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': this.authHeader,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`WordPress API error (${response.status}): site index request failed`);
    }

    const text = await readResponseBody(response);
    return JSON.parse(text);
  }

  /**
   * Upload media via multipart form data.
   * @param {Buffer} fileBuffer - File content
   * @param {string} filename - Original filename
   * @param {string} contentType - MIME type
   * @param {object} [meta] - Additional fields (title, alt_text, caption)
   * @returns {Promise<object>}
   */
  async uploadMedia(fileBuffer, filename, contentType, meta = {}) {
    // Enforce 10MB file size limit
    const MAX_FILE_SIZE = 10 * 1024 * 1024;
    if (fileBuffer.length > MAX_FILE_SIZE) {
      throw new Error(`File too large (${(fileBuffer.length / 1024 / 1024).toFixed(1)}MB). Maximum: 10MB`);
    }

    // Validate MIME type against safe upload types
    const ALLOWED_MIME_PREFIXES = ['image/', 'video/', 'audio/', 'application/pdf', 'application/msword',
      'application/vnd.openxmlformats', 'application/vnd.ms-', 'text/csv', 'text/plain'];
    const mimeOk = ALLOWED_MIME_PREFIXES.some(prefix => contentType.startsWith(prefix));
    if (!mimeOk) {
      throw new Error('Unsupported content type — only images, videos, audio, PDFs, Office docs, and text files are allowed');
    }

    const url = `${this.baseUrl}${this.pathPrefix}/wp-json/wp/v2/media`;

    // Sanitise filename: strip path traversal, control chars, quotes
    const safeFilename = filename
      .replace(/[/\\]/g, '')
      .replace(/["\r\n\0]/g, '')
      .replace(/^\.+/, '');
    if (!safeFilename) {
      throw new Error('Invalid filename');
    }

    // Cryptographically random boundary to prevent injection via meta values
    const { randomBytes: nodeRandomBytes } = await import('node:crypto');
    const boundary = '----WPMCP' + nodeRandomBytes(16).toString('hex');
    const parts = [];

    // Sanitise contentType — strip control chars to prevent header injection
    const safeContentType = contentType.replace(/[\r\n\0]/g, '');

    // File part
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeFilename}"\r\n` +
      `Content-Type: ${safeContentType}\r\n\r\n`
    );
    parts.push(fileBuffer);
    parts.push('\r\n');

    // Meta fields — sanitise values to prevent boundary injection
    const SAFE_META_KEYS = ['title', 'alt_text', 'caption', 'description'];
    for (const [key, value] of Object.entries(meta)) {
      if (value !== undefined && value !== null && SAFE_META_KEYS.includes(key)) {
        // Strip any occurrence of the boundary marker from the value
        const safeValue = String(value).replace(/[\r\n]/g, ' ');
        parts.push(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${key}"\r\n\r\n` +
          `${safeValue}\r\n`
        );
      }
    }

    parts.push(`--${boundary}--\r\n`);

    // Combine into a single Buffer
    const bodyParts = parts.map(p => typeof p === 'string' ? Buffer.from(p) : p);
    const body = Buffer.concat(bodyParts);

    // Upload timeout is longer (60s) to accommodate large files
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': this.authHeader,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const text = await readResponseBody(response, 64 * 1024);
      let detail;
      try {
        const json = JSON.parse(text);
        detail = json.code || null;
      } catch { /* ignore */ }
      throw new Error(`Media upload failed (${response.status}): ${detail || 'request failed'}`);
    }

    const text = await readResponseBody(response);
    return JSON.parse(text);
  }
}
