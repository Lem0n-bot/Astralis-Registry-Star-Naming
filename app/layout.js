// Next.js App Router root layout: the HTML document shell + global metadata
// (title, description, favicon, theme colour) applied to the React-rendered
// routes (checkout success/cancel, the order portal). The marketing site itself
// is public/index.html, served via a rewrite in next.config.mjs, so it does NOT
// pass through this layout.
export const metadata = {
  title: 'Astralis | Name a Star for Someone Special',
  description: 'Symbolic star naming as a luxury gift. Personalised certificate, celestial coordinates and a keepsake package.',
  icons: { icon: '/logo.png', apple: '/logo.png' },
  themeColor: '#080A18',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en-AU">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
