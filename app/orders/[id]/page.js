/**
 * GET /orders/:id?token=…  — the no-login "account portal".
 * A signed (HMAC) link, included in the confirmation email and shown on the
 * success page, opens this page. It verifies the token server-side and lists
 * every certificate in the order with a preview + PDF download. No account or
 * password required; the unguessable token is the credential.
 */
import { verifyToken } from '../../lib/ids.js';
import { getOrder as getSnapshot } from '../../lib/store.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Your Astralis certificates', robots: { index: false, follow: false } };

const C = {
  gold: '#D9B96C',
  goldBright: '#F2DCA2',
  star: '#F2ECDD',
  mute: '#99A2C4',
  serif: "'Cormorant Garamond', Georgia, 'Times New Roman', serif",
  sans: "'Outfit', -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
};
const PKG = { standard: 'Standard', premium: 'Premium', ultimate: 'Ultimate Gift' };

export default async function OrderPortal({ params, searchParams }) {
  const id = params?.id;
  const token = searchParams?.token || '';
  const valid = verifyToken(id, token);
  const order = valid ? await getSnapshot(id) : null;

  const page = {
    minHeight: '100svh', margin: 0, padding: '40px 16px', boxSizing: 'border-box',
    background: 'radial-gradient(900px 600px at 70% 8%, rgba(123,92,240,.16), transparent 60%), #070917',
    fontFamily: C.sans, color: C.star,
  };
  const card = {
    width: 'min(680px, 100%)', margin: '0 auto',
    background: 'linear-gradient(180deg,#10142E,#0A0D20)', border: '1px solid rgba(217,185,108,0.22)',
    borderRadius: 20, padding: '34px 26px', boxShadow: '0 40px 110px rgba(0,0,0,.6)',
  };

  if (!order || !order.fulfilled) {
    return (
      <main style={page}>
        <div style={{ ...card, textAlign: 'center' }}>
          <div style={{ fontFamily: C.serif, fontSize: 26, fontWeight: 600, letterSpacing: 2, color: C.gold }}>ASTRALIS</div>
          <div style={{ fontSize: 11, letterSpacing: 3, textTransform: 'uppercase', color: C.mute, marginTop: 6 }}>Celestial Registry</div>
          <h1 style={{ fontFamily: C.serif, fontSize: 28, fontWeight: 500, margin: '22px 0 10px' }}>This link can’t be opened.</h1>
          <p style={{ color: C.mute, fontSize: 15, lineHeight: 1.6 }}>
            The link may be incomplete or expired. Please use the button in your confirmation email, or contact{' '}
            <a href="mailto:hello@astralisregistry.com" style={{ color: C.gold }}>hello@astralisregistry.com</a>.
          </p>
          <a href="/" style={{ display: 'inline-block', marginTop: 20, padding: '12px 26px', borderRadius: 999, border: '1px solid rgba(217,185,108,0.4)', color: C.star, textDecoration: 'none' }}>Return to Astralis</a>
        </div>
      </main>
    );
  }

  const link = (certId, format) => `/api/orders/${id}/certificate/${certId}?format=${format}&token=${encodeURIComponent(token)}`;
  const plural = order.certificates.length !== 1;

  return (
    <main style={page}>
      <div style={card}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontFamily: C.serif, fontSize: 26, fontWeight: 600, letterSpacing: 2, color: C.gold }}>ASTRALIS</div>
          <div style={{ fontSize: 11, letterSpacing: 3, textTransform: 'uppercase', color: C.mute, marginTop: 6 }}>Celestial Registry</div>
          <h1 style={{ fontFamily: C.serif, fontSize: 30, fontWeight: 500, margin: '20px 0 6px' }}>Your certificate{plural ? 's' : ''}</h1>
          <p style={{ color: C.mute, fontSize: 14, margin: 0 }}>
            Order <b style={{ color: C.goldBright }}>{order.orderNo}</b>
            {order.emailStatus === 'failed' ? ' · email delivery is being retried — your downloads are ready below.' : ''}
          </p>
        </div>

        <div style={{ marginTop: 26, display: 'grid', gap: 16 }}>
          {order.certificates.map((c) => (
            <div key={c.certId} style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(217,185,108,0.2)', borderRadius: 14, padding: 14 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={link(c.certId, 'png')} alt={`Certificate for ${c.name}`} width={120} style={{ width: 120, height: 'auto', borderRadius: 8, border: '1px solid rgba(217,185,108,0.3)', flex: 'none' }} />
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontFamily: C.serif, fontSize: 22, color: C.star }}>{c.name}</div>
                <div style={{ fontSize: 12, letterSpacing: 1, color: C.mute, margin: '4px 0 12px' }}>
                  Certificate {c.certId}
                  {c.starId ? ` · ${c.starId}` : ''}
                  {c.theme ? ` · ${c.theme === 'ivory' ? 'Ivory' : 'Midnight'}` : ''}
                </div>
                <a href={link(c.certId, 'pdf')} style={{ display: 'inline-block', padding: '11px 22px', borderRadius: 999, background: `linear-gradient(135deg, ${C.goldBright}, ${C.gold})`, color: '#1a1405', fontWeight: 600, fontSize: 14, textDecoration: 'none' }}>
                  Download PDF
                </a>
              </div>
            </div>
          ))}
        </div>

        <p style={{ color: C.mute, fontSize: 12.5, lineHeight: 1.6, textAlign: 'center', marginTop: 24 }}>
          Keep this page bookmarked — your certificate{plural ? 's stay' : ' stays'} available here. Printed keepsakes ship within Australia.
        </p>
        <div style={{ textAlign: 'center' }}>
          <a href="/" style={{ display: 'inline-block', marginTop: 6, padding: '12px 26px', borderRadius: 999, border: '1px solid rgba(217,185,108,0.4)', color: C.star, textDecoration: 'none' }}>Back to Astralis</a>
        </div>
      </div>
    </main>
  );
}
