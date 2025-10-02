$ErrorActionPreference = 'Stop'
$p = 'd:\MobilUygulamalar\HemenKonus\backend\src\server.js'
$c = Get-Content -Raw -Encoding UTF8 $p
$orig = $c

# Replace existing /ocr pretty route with /ceviri and add redirect for /ocr
$pattern = "app.get\(\['/ocr', '/ocr/'\], \(_req, res\) => \{[\s\S]*?\}\);"
$replacement = @"
app.get(['/ceviri', '/ceviri/'], (_req, res) => {
  try {
    return res.sendFile(path.join(publicDir, 'ocr.html'));
  } catch {
    return res.status(404).end();
  }
});
// Redirect legacy OCR
app.get(['/ocr', '/ocr/'], (_req, res) => res.redirect(301, '/ceviri'));
"@
$c2 = [regex]::Replace($c, $pattern, $replacement, 1)
if ($c2 -ne $c) {
  $c = $c2
} else {
  Write-Host 'WARN: /ocr pretty route block not found. Inserting new /ceviri block after /realtime block.'
  $anchor = "app.get\(\['/realtime', '/realtime/'\], \(_req, res\) => \{[\s\S]*?\}\);\s*// Redirect legacy \\.html path to pretty URL\s*app.get\('/realtime\\.html', \(_req, res\) => res.redirect\(301, '/realtime'\)\);"
  if ([regex]::IsMatch($c, $anchor)) {
    $c = [regex]::Replace($c, $anchor, { param($m) $m.Value + @"

// Pretty URL for OCR page
app.get(['/ceviri', '/ceviri/'], (_req, res) => {
  try {
    return res.sendFile(path.join(publicDir, 'ocr.html'));
  } catch {
    return res.status(404).end();
  }
});
// Redirect legacy OCR
app.get(['/ocr', '/ocr/'], (_req, res) => res.redirect(301, '/ceviri'));

"@ }, 1)
  } else {
    Write-Host 'WARN: Anchor not found; no insertion performed.'
  }
}

if ($c -ne $orig) {
  Set-Content -Path $p -Value $c -Encoding UTF8
  Write-Host 'server.js updated for /ceviri.'
} else {
  Write-Host 'No changes applied.'
}
