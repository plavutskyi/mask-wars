# Puts the bounty contract on its own account ($Bounty: bounty.tinygif8324.testnet, bounty.maskwars.near on mainnet) in
# one transaction signed by $Admin: create the account, fund it (fund.bounty in packages/network: about 1.7 NEAR pays
# for the code, the rest is margin), deploy the code and call new(...). The transaction adds no key, so the account is
# born with none: nobody, the owner included, can deploy to it or move its NEAR by hand. Its code, judge and admin change
# only through the contract itself, after a wait anyone can see (bounty-change.ps1).
#
# new(...) gets: OutLayer's contract of this network, the judge in judge-args.json (every bounty keeps the judge it
# opened with), $Admin as the admin who may propose changes, and the code hash of the live safe that safe-deploy.ps1 and
# the season put on chain. The wasm files are the CI artifacts `maskwars-bounty-wasm` and `maskwars-live-safe-wasm`, put
# next to near.exe (.scratch\near-mainnet on mainnet). The CLI shows the transaction: the owner chooses "send".
#   .\bounty-deploy.ps1 -Network mainnet -DryRun
param([string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
$wasm = Get-Artifact 'maskwars_bounty.wasm'
$safe = Get-Artifact 'maskwars_live_safe.wasm'
$judge = (Read-Input 'judge-args.json').version
$init = Get-ScratchFile 'bounty-init-args.json'
$initArgs = [ordered]@{ outlayer = $Outlayer; judge_project = "$Admin/judge"; judge_version = $judge; admin = $Admin; safe_codes = @(Get-CodeHash $safe) }
$initArgs | ConvertTo-Json -Compress | Set-Content -Encoding ascii $init
Write-Host "contract code sha256 $(Get-Sha256Hex $wasm)"
Invoke-Near transaction construct-transaction $Admin $Bounty add-action create-account add-action transfer "$($Net.fund.bounty) NEAR" add-action deploy-contract use-file $wasm with-init-call new file-args $init prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' skip network-config $Network sign-with-keychain
Remove-Item $init
Remove-Scratch
