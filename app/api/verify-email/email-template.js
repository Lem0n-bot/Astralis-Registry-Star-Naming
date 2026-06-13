/**
 * On-brand verification email. Table-based, fully inline CSS for maximum
 * compatibility with Gmail / Outlook / Apple Mail (which strip <style> blocks),
 * and mobile-responsive via fluid widths.
 */
export function verificationEmailHtml(code) {
  const digits = String(code)
    .split('')
    .map(
      (d) =>
        `<span style="display:inline-block;min-width:34px;margin:0 4px;padding:14px 0;font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-size:38px;font-weight:600;color:#F2ECDD;border-bottom:2px solid rgba(217,185,108,0.5);">${d}</span>`
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<title>Your Astralis verification code</title>
</head>
<body style="margin:0;padding:0;background-color:#070917;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#070917;">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;width:100%;background:linear-gradient(180deg,#10142E,#0A0D20);border:1px solid rgba(217,185,108,0.18);border-radius:18px;overflow:hidden;">
        <tr>
          <td align="center" style="padding:34px 28px 8px 28px;">
            <div style="font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-size:26px;font-weight:600;letter-spacing:2px;color:#D9B96C;">ASTRALIS</div>
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#99A2C4;margin-top:6px;">Registry</div>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:18px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#C9D0E6;">
            Verify your email to complete your star naming.
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:26px 24px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="background:rgba(255,255,255,0.04);border:1px solid rgba(217,185,108,0.22);border-radius:14px;">
              <tr>
                <td align="center" style="padding:18px 20px;">
                  ${digits}
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:0 32px 6px 32px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#99A2C4;">
            This code expires in 10 minutes.
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:14px 32px 30px 32px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#6E7799;">
            If you didn&rsquo;t request this code, you can safely ignore this email.
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:18px 32px;border-top:1px solid rgba(255,255,255,0.06);font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:1px;color:#6E7799;">
            Astralis Registry &middot; astralisregistry.com
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}
