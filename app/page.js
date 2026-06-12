// Fallback only — the root URL is rewritten to /index.html (the Astralis site)
// in next.config.mjs before this route is ever reached.
export default function Home() {
  return null;
}
