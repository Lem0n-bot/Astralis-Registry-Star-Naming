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
