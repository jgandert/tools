/* Presentation-only asset resolution. No network access, dependency or build step.
   The editable CSS and original ZIP bytes are never mutated. */
(() => {
  'use strict';
  const FONT_TYPES = { woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf' };
  const TYPES = { ...FONT_TYPES, svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
    jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
    ico: 'image/x-icon', mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm' };
  const extension = name => name.split('.').pop().toLowerCase();
  const isFont = name => Object.hasOwn(FONT_TYPES, extension(name));
  const mimeType = name => TYPES[extension(name)] || 'application/octet-stream';

  function dataUrl(bytes, type) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const chunks = [];
    // A multiple of three avoids padding in the middle of the concatenation.
    // Bounded calls also avoid an argument-stack overflow with large fonts.
    for (let offset = 0; offset < view.length; offset += 24576) {
      chunks.push(btoa(String.fromCharCode(...view.subarray(offset, offset + 24576))));
    }
    return `data:${type};base64,` + chunks.join('');
  }
  function releaseUrls(urls) {
    for (const url of urls.values()) if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  }
  function urlsFor(files) {
    const urls = new Map();
    try {
      for (const [name, bytes] of files) {
        // Embed font bytes in the runtime CSS, rather than relying on a Blob
        // URL created by the parent document being fetchable by a srcdoc frame.
        urls.set(name, isFont(name) ? dataUrl(bytes, mimeType(name)) :
          URL.createObjectURL(new Blob([bytes], { type: mimeType(name) })));
      }
      return urls;
    } catch (error) { releaseUrls(urls); throw error; }
  }
  function resolve(reference, urls) {
    const source = String(reference || '').trim();
    if (/^data:/i.test(source)) return { source, kind: 'data', url: source };
    if (source.startsWith('#')) return { source, kind: 'fragment', url: source };
    if (/^[a-z][a-z0-9+.-]*:/i.test(source) || source.startsWith('/')) {
      return { source, kind: 'blocked', url: null };
    }
    const hashIndex = source.indexOf('#');
    const hash = hashIndex < 0 ? '' : source.slice(hashIndex);
    const pathAndQuery = hashIndex < 0 ? source : source.slice(0, hashIndex);
    const encoded = pathAndQuery.split('?')[0];
    let path;
    try { path = decodeURIComponent(encoded); } catch { path = encoded; }
    // Percent decoding must not turn a relative reference into an absolute one.
    if (path.startsWith('/') || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path)) {
      return { source, kind: 'blocked', url: null };
    }
    const parts = [];
    for (const part of path.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!parts.length) return { source, kind: 'blocked', url: null };
        parts.pop();
      } else parts.push(part);
    }
    path = parts.join('/');
    const url = urls.get(path);
    return { source, path, kind: url ? 'asset' : 'missing', url: url ? url + hash : null };
  }

  const space = c => c !== undefined && /[ \t\r\n\f]/.test(c);
  const hex = c => c !== undefined && /[0-9a-f]/i.test(c);
  const nameChar = c => c !== undefined && /[-_a-z0-9\u0080-\uffff]/i.test(c);
  function escapeEnd(text, offset) {
    let i = offset + 1;
    if (hex(text[i])) {
      const start = i;
      while (i < text.length && i - start < 6 && hex(text[i])) i++;
      if (space(text[i])) { if (text[i] === '\r' && text[i + 1] === '\n') i++; i++; }
    } else if (text[i] === '\r' && text[i + 1] === '\n') i += 2;
    else if (i < text.length) i++;
    return i;
  }
  function decodeCss(text) {
    return text.replace(/\\(?:([0-9a-f]{1,6})(?:\r\n|[ \t\r\n\f])?|\r\n|[\n\r\f]|([^\n\r\f]))/gi,
      (_, digits, character) => {
        if (!digits) return character || '';
        const point = parseInt(digits, 16);
        return !point || point > 0x10ffff || point >= 0xd800 && point <= 0xdfff ? '\ufffd' : String.fromCodePoint(point);
      });
  }
  function stringEnd(text, start) {
    const quote = text[start];
    let i = start + 1;
    while (i < text.length) {
      if (text[i] === '\\') i = escapeEnd(text, i);
      else if (text[i++] === quote) return i;
    }
    return i;
  }
  function parseUrl(text, start) {
    let i = start;
    while (space(text[i])) i++;
    let raw;
    if (text[i] === '"' || text[i] === "'") {
      const end = stringEnd(text, i);
      if (end <= i + 1 || text[end - 1] !== text[i]) return null;
      raw = text.slice(i + 1, end - 1);
      i = end;
      while (space(text[i])) i++;
    } else {
      const begin = i;
      while (i < text.length && text[i] !== ')') {
        if (text[i] === '\\') i = escapeEnd(text, i);
        else if (text[i] === '"' || text[i] === "'" || text[i] === '(') return null;
        else i++;
      }
      raw = text.slice(begin, i).trim();
    }
    return text[i] === ')' ? { source: decodeCss(raw), end: i + 1 } : null;
  }
  function rewriteCss(css, urls) {
    const output = [], references = [];
    let i = 0;
    while (i < css.length) {
      if (css.startsWith('/*', i)) {
        const close = css.indexOf('*/', i + 2), end = close < 0 ? css.length : close + 2;
        const comment = css.slice(i, end);
        // DevTools cannot resolve relative/empty source maps from about:srcdoc.
        // Strip debugging directives only in the rendered copy of the CSS.
        output.push(/^\/\*\s*[@#]\s*source(?:Mapping)?URL\s*=/i.test(comment) ?
          '/* Source-map directive omitted in presentation preview. */' : comment);
        i = end;
      } else if (css[i] === '"' || css[i] === "'") {
        const end = stringEnd(css, i); output.push(css.slice(i, end)); i = end;
      } else if (nameChar(css[i]) || css[i] === '\\') {
        const start = i;
        while (nameChar(css[i]) || css[i] === '\\') i = css[i] === '\\' ? escapeEnd(css, i) : i + 1;
        const name = css.slice(start, i);
        if (decodeCss(name).toLowerCase() === 'url' && css[i] === '(') {
          const parsed = parseUrl(css, i + 1);
          if (parsed) {
            const reference = resolve(parsed.source, urls);
            references.push(reference);
            const url = (reference.url || 'data:,').replace(/["\\\n\r\f]/g, c =>
              c === '\n' || c === '\r' || c === '\f' ? '\\a ' : '\\' + c);
            output.push('url("' + url + '")');
            i = parsed.end;
            continue;
          }
        }
        output.push(name);
      } else output.push(css[i++]);
    }
    return { css: output.join(''), references };
  }
  window.presentationAssets = Object.freeze({ isFont, mimeType, urlsFor, releaseUrls, resolve, rewriteCss });
})();
