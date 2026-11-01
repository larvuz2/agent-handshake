// "Add to my agent" button: an SVG badge for READMEs and a tiny script for websites.

import { escapeHtml } from './util/html.js';

const MARK_PATHS = (a, b, id) =>
  `<defs><clipPath id="${id}"><rect x="22" y="36" width="20" height="16"/></clipPath></defs>` +
  `<rect x="6.5" y="19" width="33" height="26" rx="13" fill="none" stroke="${a}" stroke-width="7"/>` +
  `<rect x="24.5" y="19" width="33" height="26" rx="13" fill="none" stroke="${b}" stroke-width="7"/>` +
  `<rect x="6.5" y="19" width="33" height="26" rx="13" fill="none" stroke="${a}" stroke-width="7" clip-path="url(#${id})"/>`;

export function badgeSvg({ label = 'Add to my agent', theme = 'blue' } = {}) {
  const text = escapeHtml(label);
  const width = Math.round(58 + label.length * 8.6);
  const bg = theme === 'dark' ? '#0B1020' : '#2B59FF';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="44" viewBox="0 0 ${width} 44" role="img" aria-label="${text}">
<title>${text}</title>
<rect width="${width}" height="44" rx="22" fill="${bg}"/>
<g transform="translate(12 6) scale(0.5)">${MARK_PATHS('#ffffff', '#bfe9ff', 'ahb')}</g>
<text x="50" y="27.5" fill="#ffffff" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif" font-size="15" font-weight="700">${text}</text>
</svg>`;
}

export function buttonScript(publicUrl) {
  return `/* Agent Handshake button. Usage:
   <script src="${publicUrl}/button.js" data-service="SERVICE_ID" async></script>
   or <a data-agent-handshake="SERVICE_ID"></a> anywhere on the page plus the script once. */
(function () {
  var BASE = ${JSON.stringify(publicUrl)};
  var MARK = '<svg width="26" height="26" viewBox="0 0 64 64" aria-hidden="true">${MARK_PATHS('#ffffff', '#bfe9ff', 'ahbtn').replace(/'/g, "\\'")}</svg>';
  function style(a) {
    a.style.cssText = 'display:inline-flex;align-items:center;gap:10px;padding:11px 22px 11px 16px;border-radius:999px;' +
      'background:#2B59FF;color:#fff;font:700 16px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;' +
      'text-decoration:none;box-shadow:0 8px 24px rgba(43,89,255,.3)';
    a.onmouseenter = function () { a.style.background = '#1D43D8'; };
    a.onmouseleave = function () { a.style.background = '#2B59FF'; };
  }
  function make(id, label, el) {
    var a = el && el.tagName === 'A' ? el : document.createElement('a');
    a.href = BASE + '/add/' + encodeURIComponent(id);
    a.innerHTML = MARK + '<span>' + (label || 'Add to my agent') + '</span>';
    a.setAttribute('data-agent-handshake-ready', '1');
    style(a);
    return a;
  }
  var s = document.currentScript;
  if (s && s.getAttribute('data-service')) {
    s.parentNode.insertBefore(make(s.getAttribute('data-service'), s.getAttribute('data-label')), s);
  }
  function scan() {
    var els = document.querySelectorAll('[data-agent-handshake]:not([data-agent-handshake-ready])');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var a = make(el.getAttribute('data-agent-handshake'), el.getAttribute('data-label'), el);
      if (a !== el) el.appendChild(a);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan); else scan();
})();
`;
}
