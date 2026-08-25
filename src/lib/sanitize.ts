/**
 * Minimal HTML sanitizer for podcast show notes. Keeps basic formatting and
 * links, strips everything that could execute or leak (scripts, handlers,
 * styles, non-http(s) URLs).
 */

const ALLOWED = new Set([
  'P',
  'A',
  'UL',
  'OL',
  'LI',
  'B',
  'STRONG',
  'I',
  'EM',
  'U',
  'S',
  'BR',
  'HR',
  'BLOCKQUOTE',
  'CODE',
  'PRE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'DIV',
  'SPAN',
  'IMG',
  'FIGURE',
  'FIGCAPTION',
  'TABLE',
  'THEAD',
  'TBODY',
  'TR',
  'TD',
  'TH',
]);

const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'LINK', 'META']);

function isSafeUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

function clean(el: Element): void {
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) continue;
    if (child.nodeType !== Node.ELEMENT_NODE) {
      child.remove();
      continue;
    }
    const c = child as Element;
    if (DROP.has(c.tagName)) {
      c.remove();
      continue;
    }
    clean(c);
    if (!ALLOWED.has(c.tagName)) {
      c.replaceWith(...Array.from(c.childNodes));
      continue;
    }
    for (const attr of Array.from(c.attributes)) {
      const keepHref =
        c.tagName === 'A' && attr.name === 'href' && isSafeUrl(c.getAttribute('href') ?? '');
      const keepSrc =
        c.tagName === 'IMG' && attr.name === 'src' && isSafeUrl(c.getAttribute('src') ?? '');
      if (!keepHref && !keepSrc) c.removeAttribute(attr.name);
    }
    if (c.tagName === 'A') {
      c.setAttribute('target', '_blank');
      c.setAttribute('rel', 'noopener noreferrer');
    }
    if (c.tagName === 'IMG') c.setAttribute('loading', 'lazy');
  }
}

export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  clean(doc.body);
  return doc.body.innerHTML;
}

/** True when the string looks like it contains HTML markup (vs plain text). */
export function looksLikeHtml(text: string): boolean {
  return /<[a-z][\s\S]*>/i.test(text);
}
