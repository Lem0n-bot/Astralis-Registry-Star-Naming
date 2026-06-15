const C = {
  gold: '#D9B96C',
  goldBright: '#F2DCA2',
  star: '#F2ECDD',
  mute: '#99A2C4',
  serif: "'Cormorant Garamond', Georgia, 'Times New Roman', serif",
  sans: "'Outfit', -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
};

export const metadata = { title: 'Checkout cancelled · Astralis' };

export default function CheckoutCancel() {
  return (
    <main
      style={{
        minHeight: '100svh',
        margin: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px 16px',
        background: `radial-gradient(900px 600px at 70% 10%, rgba(123,92,240,.14), transparent 60%), #070917`,
        fontFamily: C.sans,
        color: C.star,
      }}
    >
      <div
        style={{
          width: 'min(440px, 100%)',
          background: 'linear-gradient(180deg,#10142E,#0A0D20)',
          border: '1px solid rgba(217,185,108,0.22)',
          borderRadius: 20,
          padding: '40px 28px',
          textAlign: 'center',
          boxShadow: '0 40px 110px rgba(0,0,0,.6)',
        }}
      >
        <div style={{ fontFamily: C.serif, fontSize: 26, fontWeight: 600, letterSpacing: 2, color: C.gold }}>ASTRALIS</div>
        <div style={{ fontSize: 11, letterSpacing: 3, textTransform: 'uppercase', color: C.mute, marginTop: 6 }}>Registry</div>
        <h1 style={{ fontFamily: C.serif, fontSize: 28, fontWeight: 500, margin: '24px 0 8px' }}>Checkout cancelled</h1>
        <p style={{ color: C.mute, fontSize: 15, lineHeight: 1.6, margin: '0 0 24px' }}>
          No payment was taken and your star is still waiting. You can pick up right where you left off.
        </p>
        <a
          href="/"
          style={{
            display: 'inline-block',
            width: '100%',
            boxSizing: 'border-box',
            padding: '14px 0',
            borderRadius: 999,
            background: `linear-gradient(135deg, ${C.goldBright}, ${C.gold})`,
            color: '#1a1405',
            fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          Return to Astralis
        </a>
      </div>
    </main>
  );
}
