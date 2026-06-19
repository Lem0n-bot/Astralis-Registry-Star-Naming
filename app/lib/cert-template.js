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

let _sigUri = null;
/** The CEO ink signature as a data URI, so it renders under headless Chromium
 *  (page.setContent has no base URL, so a "/signature.png" src would 404). */
function signatureUri() {
  if (_sigUri !== null) return _sigUri;
  try {
    const buf = readFileSync(path.join(process.cwd(), 'public', 'signature.png'));
    _sigUri = 'data:image/png;base64,' + buf.toString('base64');
  } catch (e) {
    console.error('[cert-template] signature.png not found', e?.message);
    _sigUri = '';
  }
  return _sigUri;
}

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
window.CERT_SIG=${JSON.stringify(signatureUri())};
window.CERT_DATA=${JSON.stringify(data)};
${h1}
${gen}
</script>
<script>
/* Render in a SEPARATE <script> so that any failure in the generators above
   (e.g. a canvas texture misbehaving under headless Chromium) can never leave
   the certificate blank — certTemplate is hoisted globally and still callable.
   Render the content FIRST, then key the signature's white background to
   transparency as a best-effort enhancement. A safety timeout guarantees
   window.__certReady is set even if the signature image never fires an event. */
(function(){
  var DATA=window.CERT_DATA||{};
  try{ document.getElementById('C').innerHTML=certTemplate(DATA); }
  catch(e){ try{ console.error('[cert] render failed:', e&&e.message); }catch(_){} }
  if(DATA.certId){
    var qr=document.querySelector('#C .ct-qr');
    if(qr){
      var s=document.createElement('div');
      s.style.cssText='margin-top:.5cqw;font-size:1.12cqw;letter-spacing:.1em;text-transform:uppercase;color:var(--cmut)';
      s.textContent='Certificate No. '+DATA.certId;
      qr.appendChild(s);
    }
  }
  var ready=false;
  function done(){ if(ready)return; ready=true; window.__certReady=true; }
  setTimeout(done,2500); // never block the render waiting on the signature image
  try{
    if(window.CERT_SIG){
      var img=new Image();
      img.onload=function(){
        try{
          var c=document.createElement('canvas');c.width=img.naturalWidth||500;c.height=img.naturalHeight||500;
          var x=c.getContext('2d');x.drawImage(img,0,0);
          var d=x.getImageData(0,0,c.width,c.height),a=d.data;
          for(var i=0;i<a.length;i+=4){var r=a[i],g=a[i+1],b=a[i+2],mn=Math.min(r,g,b),mx=Math.max(r,g,b);
            if(mn>205&&mx-mn<26)a[i+3]=0;else if(mn>140)a[i+3]=Math.round(a[i+3]*(1-(mn-140)/130));}
          x.putImageData(d,0,0);var keyed=c.toDataURL('image/png');
          var ims=document.querySelectorAll('#C .ct-sigimg');for(var j=0;j<ims.length;j++)ims[j].src=keyed;
        }catch(e){}
        done();
      };
      img.onerror=done;
      img.src=window.CERT_SIG;
    } else done();
  }catch(e){ done(); }
})();
</script>
</body></html>`;
}
