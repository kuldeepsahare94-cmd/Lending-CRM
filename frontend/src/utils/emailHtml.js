import DOMPurify from 'dompurify';

/* ------------------------------------------------------------------
   Rendering HTML that arrived from outside is a genuine XSS risk — the
   sender controls it entirely. Everything is sanitised before it can
   reach the DOM.

   Beyond stripping scripts, two things are enforced on links, because a
   sanitiser alone doesn't cover them:
     - target="_blank" plus rel="noopener noreferrer", so a linked page
       can't reach back into this tab
     - remote images are blocked until the reader opts in, which is what
       mail clients do: loading them silently confirms to a sender that
       the address is live and being read.
   ------------------------------------------------------------------ */

const ALLOWED_TAGS = [
  'a', 'b', 'i', 'u', 'em', 'strong', 'p', 'br', 'div', 'span', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code',
  'table', 'thead', 'tbody', 'tr', 'td', 'th', 'img', 'hr', 'font', 'small', 'sub', 'sup',
];
const ALLOWED_ATTR = ['href', 'src', 'alt', 'title', 'width', 'height', 'style', 'align', 'size', 'color', 'target', 'rel', 'data-blocked-src'];

export function sanitizeEmailHtml(html, { allowImages = false } = {}) {
  if (!html) return '';

  // Hook runs per-node during sanitisation.
  const hook = (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    if (node.tagName === 'IMG' && !allowImages) {
      const src = node.getAttribute('src') || '';
      // Inline (cid:/data:) images are part of the message itself and
      // don't phone home, so only remote ones are held back.
      if (/^https?:/i.test(src)) {
        node.setAttribute('data-blocked-src', src);
        node.removeAttribute('src');
        node.setAttribute('alt', node.getAttribute('alt') || 'Image blocked');
        node.setAttribute('style', 'display:none');
      }
    }
  };

  DOMPurify.addHook('afterSanitizeAttributes', hook);
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'link', 'meta'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
    ALLOW_DATA_ATTR: false,
  });
  DOMPurify.removeHook('afterSanitizeAttributes');
  return clean;
}

// True when the message contains remote images currently being withheld,
// so the UI can offer a "show images" control rather than silently hiding
// content.
export function hasBlockedImages(html) {
  return !!html && /<img[^>]*data-blocked-src=/i.test(html);
}
