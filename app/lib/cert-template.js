/**
 * Server-side certificate HTML generator. To stay pixel-faithful to the live
 * preview (and never drift), it reuses the certificate generators straight from
 * public/index.html — certTemplate / certSealSVG / starMapSVG / certGalaxyTexture
 * / h1 — plus the site stylesheet, assembling a standalone A4 document the
 * Chromium renderer turns into a PDF/PNG. Those generators run in the browser
 * (where <canvas> works), not in Node.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CERT_W, CERT_H } from './render.js';

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let _assets = null;
function assets() {
  if (_assets) return _assets;
  const src = readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');

  const styleM = src.match(/<style>([\s\S]*?)<\/style>/); // first = main site stylesheet
  const fontM = src.match(/<link href="https:\/\/fonts\.googleapis[^"]*"[^>]*>/);

  // cert generators block: CERT_EMB … certTemplate (just before CERT_DEFAULTS)
  const gs = src.indexOf('const CERT_EMB=');
  const ge = src.indexOf('const CERT_DEFAULTS=');
  // h1 hash, used by starMapSVG (lives further down the file)
  const hs = src.indexOf('function h1(');
  const he = src.indexOf('}', hs) + 1;

  if (gs < 0 || ge < 0 || hs < 0) {
    throw new Error('cert-template: could not locate certificate generators in public/index.html');
  }

  _assets = {
    css: styleM ? styleM[1] : '',
    fontLink: fontM ? fontM[0] : '',
    gen: src.slice(gs, ge),
    h1: src.slice(hs, he),
  };
  return _assets;
}

/**
 * @param {object} d certificate data
 *   {name,msg,recip,occ,ra,dec,cons,mag,sec,cls,id,seed,theme,certId}
 * @returns {string} standalone HTML document (rendered by Chromium)
 */
export function buildCertificateHtml(d) {
  const { css, fontLink, gen, h1 } = assets();
  const ivory = d.theme === 'ivory';

  // escape every user-controlled field before it reaches certTemplate (innerHTML)
  const data = {
    name: esc(d.name) || '—',
    msg: esc(d.msg),
    recip: esc(d.recip) || '—',
    occ: esc(d.occ) || '—',
    ra: esc(d.ra) || '—',
    dec: esc(d.dec) || '—',
    cons: esc(d.cons) || '—',
    mag: esc(d.mag) || '—',
    sec: esc(d.sec) || '—',
    cls: esc(d.cls) || '—',
    id: esc(d.id) || '—',
    seed: Number.isFinite(+d.seed) ? +d.seed : 5,
    certId: esc(d.certId) || '',
  };

  return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
${fontLink}
<style>${css}</style>
<style>
  html,body{margin:0;padding:0;background:#06070f}
  #stage{width:${CERT_W}px;height:${CERT_H}px;overflow:hidden}
  #stage .cert{width:${CERT_W}px!important;margin:0!important;border-radius:0!important;animation:none!important;box-shadow:none!important}
  #stage .cert::before,#stage .cert::after{border-radius:0!important}
  @page{margin:0}
</style></head>
<body>
<div id="stage"><div class="cert${ivory ? ' ivory' : ''}" id="C"></div></div>
<script>
${h1}
${gen}
(function(){
  var DATA=${JSON.stringify(data)};
  document.getElementById('C').innerHTML=certTemplate(DATA);
  if(DATA.certId){
    var qr=document.querySelector('#C .ct-qr');
    if(qr){
      var s=document.createElement('div');
      s.style.cssText='margin-top:.5cqw;font-size:1.12cqw;letter-spacing:.1em;text-transform:uppercase;color:var(--cmut)';
      s.textContent='Certificate No. '+DATA.certId;
      qr.appendChild(s);
    }
  }
  window.__certReady=true;
})();
</script>
</body></html>`;
}
