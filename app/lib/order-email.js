/**
 * Order-confirmation email — on-brand, table-based, fully inline CSS for broad
 * client compatibility (Gmail / Outlook / Apple Mail). The full-resolution PDF
 * certificates are attached to the message; this body adds a personalised
 * greeting, an order summary, a preview + download link per star, and a button
 * to the no-login order portal where everything can be re-downloaded.
 */
import { formatMoney } from './catalog';

const BG_URL = 'https://astralisregistry.com/email-bg.png';
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const PKG_NAMES = { standard: 'Standard', premium: 'Premium', ultimate: 'Ultimate Gift' };

// Derive a friendly first name from the buyer's email (we don't collect a name).
function greetingName(email) {
  const local = String(email || '').split('@')[0] || '';
  const word = local.replace(/[._-]+/g, ' ').trim().split(' ')[0] || '';
  if (!word || /\d/.test(word) || word.length < 2) return 'customer';
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function summaryRow(it) {
  const coords = [it.star?.ra, it.star?.dec].filter(Boolean).join('  ');
  return `
  <tr>
    <td style="padding:14px 0;border-top:1px solid rgba(255,255,255,0.08);">
      <div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:20px;color:#F2ECDD;">${esc(it.name)}</div>
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#99A2C4;margin-top:3px;">
        ${esc(PKG_NAMES[it.pkg] || it.pkg)} &middot; ${esc(it.theme === 'ivory' ? 'Ivory' : 'Midnight')} finish${
    it.star?.id ? ` &middot; ${esc(it.star.id)}` : ''
  }${it.cons ? ` &middot; ${esc(it.cons)}` : ''}
      </div>
      ${coords ? `<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#6E7799;margin-top:2px;">${esc(coords)}</div>` : ''}
    </td>
    <td align="right" style="padding:14px 0;border-top:1px solid rgba(255,255,255,0.08);font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#C9D0E6;white-space:nowrap;">
      ${formatMoney(it.priceCents, '')}
    </td>
  </tr>`;
}

// One certificate card: framed preview image + a gold "Download PDF" button.
function certCard(c) {
  return `
  <tr><td style="padding:10px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:rgba(255,255,255,0.03);border:1px solid rgba(217,185,108,0.22);border-radius:14px;">
      <tr>
        <td width="116" valign="top" style="padding:12px;">
          <img src="${esc(c.pngUrl)}" width="100" alt="Certificate for ${esc(c.name)}" style="display:block;width:100px;height:auto;border-radius:8px;border:1px solid rgba(217,185,108,0.3);" />
        </td>
        <td valign="middle" style="padding:12px 14px 12px 0;">
          <div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:19px;color:#F2ECDD;">${esc(c.name)}</div>
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:1px;color:#99A2C4;margin:3px 0 10px;">Certificate ${esc(c.certId)}</div>
          <a href="${esc(c.pdfUrl)}" style="display:inline-block;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;color:#1a1405;text-decoration:none;background:linear-gradient(135deg,#F2DCA2,#D9B96C);padding:9px 16px;border-radius:999px;">Download certificate (PDF)</a>
        </td>
      </tr>
    </table>
  </td></tr>`;
}

// Standard ($39) is digital-only; Premium ($79) and Ultimate ($139) are printed
// and posted (Ultimate is framed + gift-boxed + priority).
const PHYSICAL_PKGS = new Set(['premium', 'ultimate']);

/**
 * Classify an order's fulfilment so the owner instantly knows whether anything
 * has to be printed and shipped. Mixed carts resolve to the most involved action.
 * @returns {{digitalOnly:boolean, needsShip:boolean, hasPriority:boolean, subject:string, banner:string, color:string, bg:string}}
 */
export function orderFulfilment(order) {
  const items = order.items || [];
  const hasPriority = items.some((it) => it.pkg === 'ultimate');
  const needsShip = items.some((it) => PHYSICAL_PKGS.has(it.pkg));
  if (!needsShip) return { digitalOnly: true, needsShip: false, hasPriority, subject: 'Digital only · no shipping', banner: 'DIGITAL ONLY — nothing to print or post', color: '#1f7a4d', bg: '#e7f6ee' };
  if (hasPriority) return { digitalOnly: false, needsShip: true, hasPriority: true, subject: 'PRIORITY ship', banner: 'PRIORITY — print, frame & post (gift box)', color: '#6b21a8', bg: '#f3e9fb' };
  return { digitalOnly: false, needsShip: true, hasPriority: false, subject: 'Print & ship', banner: 'PRINT & SHIP this order', color: '#9a6a00', bg: '#fbf2dc' };
}

function itemFulfilment(pkg) {
  if (pkg === 'ultimate') return { label: 'Framed · gift box · priority', color: '#6b21a8', bg: '#f3e9fb' };
  if (pkg === 'premium') return { label: 'Printed · post', color: '#9a6a00', bg: '#fbf2dc' };
  return { label: 'Digital only', color: '#1f7a4d', bg: '#e7f6ee' };
}

/**
 * Internal "new order" notification for the registry owner — a single scannable
 * summary with the buyer's name, phone, full delivery address and the purchased
 * items. A coloured banner + per-item tags make the fulfilment action obvious:
 * digital-only orders need nothing posted; Premium/Ultimate must be printed and
 * shipped. Sent to ENV.ORDER_NOTIFY_EMAIL, separate from the customer's email.
 * @param {object} order  fulfilled order snapshot (email, delivery, items, totals)
 */
export function fulfillmentNotificationHtml(order) {
  const d = order.delivery || {};
  const f = orderFulfilment(order);
  const when = new Date(order.paidAt || order.createdAt || Date.now()).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });
  const addr = [d.address1, d.address2, [d.suburb, d.city].filter(Boolean).join(', '), [d.state, d.postcode].filter(Boolean).join(' '), d.country]
    .filter(Boolean)
    .map(esc)
    .join('<br>');
  const row = (label, value) => `
    <tr>
      <td style="padding:7px 16px 7px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6E7799;white-space:nowrap;vertical-align:top;">${esc(label)}</td>
      <td style="padding:7px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#0b1020;">${value}</td>
    </tr>`;
  const items = order.items
    .map((it) => {
      const coords = [it.star?.ra, it.star?.dec].filter(Boolean).join('   ');
      const t = itemFulfilment(it.pkg);
      return `<li style="margin-bottom:12px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;color:#0b1020;">
        <b>${esc(it.name)}</b> — ${esc(PKG_NAMES[it.pkg] || it.pkg)} &middot; ${esc(it.theme === 'ivory' ? 'Ivory' : 'Midnight')}${it.star?.id ? ` &middot; ${esc(it.star.id)}` : ''}${it.cons ? ` &middot; ${esc(it.cons)}` : ''}
        <span style="display:inline-block;margin-left:4px;padding:1px 9px;border-radius:999px;font-size:11px;font-weight:bold;background:${t.bg};color:${t.color};">${esc(t.label)}</span>
        ${coords ? `<br><span style="color:#6E7799;font-size:12px;">${esc(coords)}</span>` : ''}
      </li>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:24px;background:#f4f5fa;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e3e6f0;border-radius:14px;overflow:hidden;">
    <tr><td style="padding:20px 26px;background:#0b1020;">
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#D9B96C;">Astralis &middot; New order</div>
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:21px;color:#ffffff;margin-top:5px;">${esc(order.orderNo)} &middot; ${esc(formatMoney(order.totalCents, order.currency))}</div>
    </td></tr>
    <tr><td style="padding:13px 26px;background:${f.bg};">
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;letter-spacing:.4px;color:${f.color};">${f.digitalOnly ? '&#10003; ' : '&#10148; '}${f.banner}</div>
    </td></tr>
    <tr><td style="padding:18px 26px 6px;">
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#99A2C4;margin-bottom:6px;">${f.digitalOnly ? 'Customer' : 'Ship to'}</div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        ${row('Name', '<b>' + esc(d.name || '&mdash;') + '</b>')}
        ${row('Address', addr || '&mdash;')}
        ${row('Phone', d.phone ? `<a href="tel:${esc(d.phone)}" style="color:#0b1020;text-decoration:none;">${esc(d.phone)}</a>` : '&mdash;')}
        ${row('Email', `<a href="mailto:${esc(order.email)}" style="color:#0b1020;">${esc(order.email)}</a>`)}
        ${row('Placed', esc(when))}
      </table>
    </td></tr>
    <tr><td style="padding:14px 26px 24px;">
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#99A2C4;margin-bottom:8px;">Items (${order.items.length})</div>
      <ul style="margin:0;padding-left:18px;">${items}</ul>
    </td></tr>
  </table>
</body></html>`;
}

/**
 * @param {object} order
 * @param {{certificates?:Array<{certId,name,pngUrl,pdfUrl}>, portalUrl?:string}} [opts]
 */
export function orderConfirmationHtml(order, opts = {}) {
  const certificates = opts.certificates || [];
  const portalUrl = opts.portalUrl || '';
  const viewUrl = opts.certViewUrl || portalUrl;   // client-rendered viewer (falls back to portal)
  const name = greetingName(order.email);
  const d = order.delivery || {};
  const addr = [d.address1, d.address2, [d.suburb, d.city].filter(Boolean).join(', '), [d.state, d.postcode].filter(Boolean).join(' '), d.country]
    .filter(Boolean)
    .map(esc)
    .join('<br>');
  const plural = order.items.length > 1;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="color-scheme" content="dark">
<title>Your Astralis certificates are ready</title></head>
<body style="margin:0;padding:0;background-color:#070917;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#070917;">
  <tr><td align="center" background="${BG_URL}" style="padding:32px 16px;background-color:#070917;background-image:url('${BG_URL}');background-repeat:no-repeat;background-position:top center;background-size:cover;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:rgba(13,17,40,0.82);border:1px solid rgba(217,185,108,0.22);border-radius:18px;overflow:hidden;">
      <tr><td align="center" style="padding:34px 28px 6px 28px;">
        <div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:26px;font-weight:600;letter-spacing:2px;color:#D9B96C;">ASTRALIS</div>
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#99A2C4;margin-top:6px;">Celestial Registry</div>
      </td></tr>
      <tr><td align="center" style="padding:18px 32px 2px 32px;font-family:'Cormorant Garamond',Georgia,serif;font-size:24px;color:#F2ECDD;">${plural ? 'Their stars are named.' : 'Their star is named.'}</td></tr>
      <tr><td align="left" style="padding:12px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#C9D0E6;">
        Dear ${esc(name)},<br><br>
        Thank you for your support. Your payment was successful and your order is confirmed. Your personalised certificate${plural ? 's are' : ' is'} attached to this email as a high-resolution PDF, and you can download ${plural ? 'them' : 'it'} any time below.
      </td></tr>
      <tr><td align="left" style="padding:10px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#99A2C4;">
        Order <b style="color:#D9B96C;">${esc(order.orderNo)}</b>
      </td></tr>

      ${certificates.length ? `
      <tr><td style="padding:6px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#99A2C4;">Your certificate${plural ? 's' : ''}</td></tr>
      <tr><td style="padding:4px 32px 6px 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${certificates.map(certCard).join('')}</table>
      </td></tr>` : ''}

      ${viewUrl ? `
      <tr><td align="center" style="padding:8px 32px 20px 32px;">
        <a href="${esc(viewUrl)}" style="display:inline-block;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:600;color:#1a1405;text-decoration:none;background:linear-gradient(135deg,#F2DCA2,#D9B96C);padding:13px 30px;border-radius:999px;">View your certificate${plural ? 's' : ''}</a>
      </td></tr>` : ''}

      <tr><td style="padding:6px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#99A2C4;">Order summary</td></tr>
      <tr><td style="padding:4px 32px 8px 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          ${order.items.map(summaryRow).join('')}
          <tr><td style="padding:14px 0 0 0;border-top:1px solid rgba(217,185,108,0.3);font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#F2ECDD;">Total</td>
          <td align="right" style="padding:14px 0 0 0;border-top:1px solid rgba(217,185,108,0.3);font-family:'Cormorant Garamond',Georgia,serif;font-size:20px;color:#D9B96C;white-space:nowrap;">${esc(formatMoney(order.totalCents, order.currency))}</td></tr>
        </table>
      </td></tr>

      <tr><td style="padding:10px 32px 4px 32px;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#99A2C4;">Delivery</td></tr>
      <tr><td style="padding:0 32px 18px 32px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;color:#C9D0E6;">${addr || '&mdash;'}</td></tr>
      <tr><td align="center" style="padding:6px 32px 26px 32px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#6E7799;">
        Printed keepsakes ship within Australia. Keep this email — your certificate link${plural ? 's stay' : ' stays'} live in the registry.
      </td></tr>
      <tr><td align="center" style="padding:16px 32px;border-top:1px solid rgba(255,255,255,0.06);font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:1px;color:#6E7799;">
        Astralis Celestial Registry &middot; astralisregistry.com
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}
