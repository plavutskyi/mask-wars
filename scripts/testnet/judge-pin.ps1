# Registers the judge wasm in judge-version-args.json as a version of the OutLayer project $Admin/judge on this network
# (outlayer.testnet or outlayer.near; 0.01 NEAR for its storage, the rest comes back). When the project is not there yet,
# the script makes it with this judge as its first and active version (0.02 NEAR, the rest comes back). The file must
# already be served at its maskwars.xyz/outlayer address, and its name is its sha256: this script downloads it and stops
# unless the bytes served are the bytes named, so a version never points at a missing file or at another judge. A
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
# The project itself is made by the first version: OutLayer's create_project takes the name and the first source, and
# makes that version the active one. Whether the project exists is read from the chain, never assumed: an unreadable
# answer stops the script before anything is signed.
$projectId = "$Admin/$($version.project_name)"
$ask = @{
  jsonrpc = '2.0'; id = 1; method = 'query'
  params = @{
    request_type = 'call_function'; finality = 'final'; account_id = $Outlayer; method_name = 'get_project'
    args_base64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("{`"project_id`":`"$projectId`"}"))
  }
} | ConvertTo-Json -Depth 5 -Compress
try {
  $said = Invoke-RestMethod -Uri $Net.rpc[0] -Method Post -ContentType 'application/json' -Body $ask
  if ($null -eq $said.result.result) { throw "the node answered no result" }
  $project = [Text.Encoding]::UTF8.GetString([byte[]]$said.result.result)
} catch {
  Write-Error "cannot read $projectId from ${Outlayer}: $($_.Exception.Message). Nothing was sent"; exit 1
}
if ($project -eq 'null') {
  Write-Host "$projectId is not on $Outlayer yet: this judge makes it, as its first and active version"
  $first = Get-ScratchFile 'judge-project-args.json'
  New-Item -ItemType Directory -Force (Split-Path $first) | Out-Null
  $body = [ordered]@{ name = $version.project_name; source = $version.source } | ConvertTo-Json -Depth 6 -Compress
  [System.IO.File]::WriteAllText($first, $body, (New-Object System.Text.UTF8Encoding($false)))
  Invoke-Near contract call-function as-transaction $Outlayer create_project file-args $first prepaid-gas '50.0 Tgas' attached-deposit '0.02 NEAR' sign-as $Admin network-config $Network sign-with-keychain
} else {
  Write-Host "$projectId is on $Outlayer`: $project"
  Invoke-Near contract call-function as-transaction $Outlayer add_version file-args (Get-Input 'judge-version-args.json') prepaid-gas '50.0 Tgas' attached-deposit '0.01 NEAR' sign-as $Admin network-config $Network sign-with-keychain
}
Remove-Scratch
