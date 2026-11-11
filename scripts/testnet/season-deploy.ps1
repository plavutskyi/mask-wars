# Puts the season treasury on its own account ($Season: season.tinygif8324.testnet, season.maskwars.near on mainnet) in
# one transaction signed by $Admin: create the account, fund it (fund.season of packages/network: about 3.33 NEAR pay for
# its code), deploy the code and call new(...). The transaction adds no key, so the account is born with none: nobody,
# the owner included, can deploy to it or move its NEAR by hand. Its program and limits change only through the treasury
# itself, after a wait anyone can see (season-change.ps1).
#
# new(...) gets: the name round ids start with, $Admin as the admin who may propose changes, the scheduler
# (scheduler.ps1), the bounty contract, the limits of packages/network/<network>.json (limits.season), the program in
# season-args.json, and the code hash of each target's safe. The program must fit the limits: the treasury refuses one
# that does not, and so does this script, before anything is sent. The wasm files are from the CI artifact
# `maskwars-season-wasm`: maskwars_season.wasm and the safes from its folder safes, all put next to near.exe
# (.scratch\near-mainnet on mainnet). The owner chooses "send".
#   .\season-deploy.ps1 -Network mainnet -DryRun
param([string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
$wasm = Get-Artifact 'maskwars_season.wasm'
$a = Read-Input 'season-args.json'
$program = Get-SeasonProgram
$limits = Get-SeasonLimits
Assert-Limit "the program's bounty" $program.prize $Net.limits.season.max_prize
foreach ($t in $program.targets) { Assert-Limit "the safe of $($t.challenge)" $t.safe_fund $Net.limits.season.max_safe_fund }
foreach ($t in @($a.program.targets)) { $null = Get-Artifact $t.wasm }
$codes = @($program.targets | ForEach-Object { $_.code_hash } | Select-Object -Unique)
$init = Get-ScratchFile 'season-init-args.json'
$initArgs = [ordered]@{
  name = $a.name; admin = $Admin; scheduler = $Scheduler; bounty = $Bounty; limits = $limits; safe_codes = $codes
  program = $program
}
$initArgs | ConvertTo-Json -Depth 10 -Compress | Set-Content -Encoding ascii $init
Write-Host "treasury code sha256 $(Get-Sha256Hex $wasm)"
Invoke-Near transaction construct-transaction $Admin $Season add-action create-account add-action transfer "$($Net.fund.season) NEAR" add-action deploy-contract use-file $wasm with-init-call new file-args $init prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' skip network-config $Network sign-with-keychain
Remove-Item $init
Remove-Scratch
