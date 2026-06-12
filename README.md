# Astralis — Production Deployment (Vercel + astralis.com.au)

A production-ready HTTPS setup for the Astralis star-naming site, deployed as a Next.js project on Vercel.

The site itself lives in `public/index.html` and is served at the root URL via a rewrite. The Next.js layer provides the security headers, redirects and middleware around it, and gives you a real app framework to grow into (checkout APIs, sessions, etc).

## What's configured

| Concern | Where | How |
|---|---|---|
| SSL certificate provisioning | Vercel platform | Automatic Let's Encrypt issuance and renewal the moment the domain is added. No action needed. |
| TLS best practices | Vercel platform | TLS 1.2 and 1.3 only, modern cipher suites, OCSP stapling. Managed at the edge. |
| HTTP → HTTPS redirect | Vercel edge + `middleware.js` | Vercel 308-redirects all HTTP traffic automatically; middleware adds a defensive 301 as a second layer. |
| HSTS | `next.config.mjs` | `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` on every response. |
| Canonical host (www → apex) | `next.config.mjs` + `middleware.js` | Permanent redirect from `www.astralis.com.au` to `astralis.com.au`. |
| Secure cookies | `middleware.js` | Documented `httpOnly` + `secure` + `sameSite` pattern, ready for when sessions are added. |
| Other security headers | `next.config.mjs` | `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, hidden `X-Powered-By`. |

## 1. Push to GitHub

```bash
cd astralis
git init
git add .
git commit -m "Astralis production site with HTTPS hardening"
git branch -M main
git remote add origin https://github.com/<your-username>/astralis.git
git push -u origin main
```

## 2. Deploy on Vercel

1. Go to [vercel.com/new](https://vercel.com/new) and import the `astralis` GitHub repository.
2. Framework preset: **Next.js** (auto-detected). Leave build settings as default.
3. Click **Deploy**. You'll get a working `*.vercel.app` URL in about a minute.

## 3. Connect astralis.com.au

1. In the Vercel project: **Settings → Domains → Add**.
2. Add `astralis.com.au`, then add `www.astralis.com.au`.
3. Set `astralis.com.au` as the **primary** domain (Vercel will offer to redirect www to it — accept; our config also enforces this).
4. At your domain registrar, add the DNS records Vercel shows you. Typically:

   | Type | Name | Value |
   |---|---|---|
   | A | `@` | `76.76.21.21` |
   | CNAME | `www` | `cname.vercel-dns.com` |

   (Always use the exact values shown in your Vercel dashboard, as they can vary.)
5. Wait for DNS propagation (minutes to a few hours). Vercel will show **Valid Configuration** and automatically issue the SSL certificate for both hostnames. Renewal is automatic forever.

## 4. Verify the hardening

```bash
# HTTP must redirect to HTTPS (expect 301/308 + Location: https://...)
curl -I http://astralis.com.au

# www must redirect to apex
curl -I https://www.astralis.com.au

# HSTS and security headers present
curl -sI https://astralis.com.au | grep -iE "strict-transport|x-content|x-frame|referrer|permissions"
```

Then run the free scanners:
- https://securityheaders.com → should grade A
- https://www.ssllabs.com/ssltest/ → should grade A+ (Vercel-managed TLS)

## 5. HSTS preload (optional, read first)

The HSTS header already includes `preload`. To hard-code HTTPS for your domain into Chrome/Firefox/Safari, submit at https://hstspreload.org.

**Caution:** preloading is effectively permanent and applies to ALL subdomains. Only submit once you're certain every subdomain you'll ever use serves HTTPS.

## Local development

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build check before pushing
```

## Project structure

```
astralis/
├── public/index.html    # The complete Astralis site (galaxy explorer, checkout, pages)
├── app/                 # Minimal Next.js app shell (root rewrites to index.html)
├── middleware.js        # HTTPS + canonical host enforcement, secure-cookie pattern
├── next.config.mjs      # Security headers (HSTS etc), redirects, rewrites
└── package.json
```
