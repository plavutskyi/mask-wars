# Registers the judge wasm in judge-version-args.json as a version of the OutLayer project $Admin/judge on this network
# (outlayer.testnet or outlayer.near; 0.01 NEAR for its storage, the rest comes back). The file must already be served at
# its maskwars.xyz/outlayer address, and its name is its sha256: this script downloads it and stops unless the bytes
# served are the bytes named, so a version never points at a missing file or at another judge. A
# new bounty contract takes this judge in new(...) (bounty-deploy.ps1, from judge-args.json); a contract already on chain
# takes it only through a proposal: bounty-change.ps1 -Judge <sha256>. Bounties already open keep the judge they opened
# with. The owner chooses "send".
#   .\judge-pin.ps1 -Network mainnet -DryRun
param([string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
$version = Read-Input 'judge-version-args.json'
if ($version.source.WasmUrl.hash -ne (Read-Input 'judge-args.json').version) {
  Write-Error 'judge-version-args.json and judge-args.json name different judges: make them one'; exit 1
}
$url = $version.source.WasmUrl.url
$served = Join-Path ([System.IO.Path]::GetTempPath()) "maskwars-judge-$([guid]::NewGuid().ToString('N')).wasm"
try {
  Invoke-WebRequest -Uri $url -OutFile $served -UseBasicParsing
  $got = (Get-FileHash -Algorithm SHA256 $served).Hash.ToLowerInvariant()
} catch {
  $got = "nothing ($($_.Exception.Message))"
} finally {
  if (Test-Path $served) { Remove-Item $served }
}
if ($got -ne $version.source.WasmUrl.hash) {
  $why = "$url serves $got, not the judge $($version.source.WasmUrl.hash): release the site with the file first"
  if (-not $DryRun) { Write-Error "$why. Nothing was sent"; exit 1 }
  Write-Host "NOT READY: $why. A real run stops here." -ForegroundColor Yellow
} else {
  Write-Host "served: $url is the judge $got"
}
Invoke-Near contract call-function as-transaction $Outlayer add_version file-args (Get-Input 'judge-version-args.json') prepaid-gas '50.0 Tgas' attached-deposit '0.01 NEAR' sign-as $Admin network-config $Network sign-with-keychain
