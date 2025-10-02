$ErrorActionPreference = 'Stop'
$p = 'd:\MobilUygulamalar\HemenKonus\backend\src\server.js'
$c = Get-Content -Raw -Encoding UTF8 $p
$orig = $c

# 1) trust proxy -> true (all occurrences)
$c = [regex]::Replace($c, "app\.set\('trust proxy',\s*1\)", "app.set('trust proxy', true)")

# 2) Insert priority client IP headers before XFF chain (only if not already present)
if ($c -notmatch "cf-connecting-ip") {
    $marker = "const xff = (req.headers['x-forwarded-for'] || '').toString();"
    $inject = @"
    const priorityIp = (req.headers['cf-connecting-ip'] || req.headers['true-client-ip'] || req.headers['x-real-ip'] || req.headers['x-client-ip'] || '').toString().trim();
    let chosenIp = priorityIp && !isPrivateIp(priorityIp) ? priorityIp : null;
    const xff = (req.headers['x-forwarded-for'] || '').toString();
"@
    if ($c.Contains($marker)) { $c = $c.Replace($marker, $inject) }
    # remove duplicate chosenIp declaration if present later in the block
    $c = $c.Replace("let chosenIp = null;", "// chosenIp initialized above if present")
}

# 3) Fallback: include req.socket.remoteAddress
$c = $c.Replace("if (!chosenIp) chosenIp = (req.ip || req.connection?.remoteAddress || '').toString();", "if (!chosenIp) chosenIp = (req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || '').toString();")

# 4) Normalize IPv6 mapped prefix fully
$c = $c.Replace("const ip = chosenIp.replace('::ffff:','');", "const ip = chosenIp.replace('::ffff','').replace('::ffff:','');")

# 5) Add host field (capture Host header)
if ($c -notmatch "const host = req.headers\['host'\]") {
    $c = $c.Replace("const ua = req.get('user-agent') || null;", "const ua = req.get('user-agent') || null;`r`n    const host = req.headers['host'] || null;")
}
# 6) Inject host into analytics doc
if ($c -match "const doc = \{[\s\S]*?\};") {
    $c = $c.Replace("const doc = { path: p, referrer:", "const doc = { path: p, host, referrer:")
}

if ($c -ne $orig) {
    Set-Content -Path $p -Value $c -Encoding UTF8
    Write-Host "server.js updated."
} else {
    Write-Host "No changes applied (already up to date)."
}
