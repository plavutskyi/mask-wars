# Puts the mask factory on its own account ($Factory: masks.tinygif8324.testnet, masks.maskwars.near on mainnet) in one
# transaction signed by $Admin: create the account, fund it (fund.factory of packages/network: 3.56 NEAR lock its code
# and state, 6.02 publish the mask code once, the rest is margin), deploy the code and call new(...). The transaction
# adds no key, so the account is born with none: nobody, the owner included, can deploy to it or move its NEAR by hand
# (contracts/masks/README.md).
#
# new(...) gets: $Admin as admin, keeper and treasury; $Admin and the house as the teams whose rounds on the arena masks
# are armed for, the rounds opened by hand and the daily round (forge-change.ps1 -Teams changes the list after the
# wait); the keyless bounty contract as the arena; the mask code's sha256; the catalog in contracts/masks/catalog.json;
# the mind's key from the brain module on OutLayer, if -StrategyKey is given (without it the site forges masks without
# a plan until forge-change.ps1 -StrategyKey; give it here: after the first mask every change waits 72 h). The wasm files are the CI artifact `maskwars-masks-wasm` (maskwars_masks.wasm,
# maskwars_mask.wasm) in .scratch (.scratch\near-mainnet on mainnet). On mainnet the arguments are the reviewed file
# scripts\mainnet\forge-init-args.json, the mind's key put in, and the mask code must be the one it names
# (scripts\mainnet\forge.mjs prints the same transaction and the exact NEAR). The CLI shows the transaction and asks
# what to do with it: the owner chooses "send". Then forge-publish.ps1.
#   .\forge-deploy.ps1 -StrategyKey x25519:<hex>
#   .\forge-deploy.ps1 -Network mainnet -StrategyKey x25519:<hex> -DryRun
param([string]$StrategyKey, [string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
$wasm = Get-Artifact 'maskwars_masks.wasm'
$mask = Get-Artifact 'maskwars_mask.wasm'
$catalog = Get-Content (Join-Path $PSScriptRoot '..\..\contracts\masks\catalog.json') -Raw | ConvertFrom-Json
$init = Get-ScratchFile 'forge-init-args.json'
if ($Network -eq 'mainnet') {
  # The factory's code must be the very bytes this commit pins (scripts\mainnet\forge-wasm.json), as forge.mjs checks:
  # any other build, an older artifact included, stops here before near.exe is asked anything.
  $pins = Read-Input 'forge-wasm.json'
  $factorySha = Get-Sha256Hex $wasm
  $factoryBytes = if (Test-Path $wasm) { (Get-Item $wasm).Length } else { -1 }
  if ($factorySha -ne $pins.factory.sha256 -or $factoryBytes -ne $pins.factory.bytes) { Write-Error "maskwars_masks.wasm is $factoryBytes bytes, sha256 $factorySha; this commit pins $($pins.factory.bytes) bytes, $($pins.factory.sha256). Nothing was sent"; exit 1 }
  $initArgs = Read-Input 'forge-init-args.json'
  if ($initArgs.mask_code -ne (Get-Sha256Hex $mask)) { Write-Error "maskwars_mask.wasm is not the mask code forge-init-args.json names ($($initArgs.mask_code)). Nothing was sent"; exit 1 }
  $initArgs.strategy_key = $(if ($StrategyKey) { $StrategyKey } else { $null })
} else {
  $initArgs = [ordered]@{
    admin = $Admin; keeper = $Admin; treasury = $Admin; arena = $Bounty
    mask_code = (Get-Sha256Hex $mask)
    strategy_key = $(if ($StrategyKey) { $StrategyKey } else { $null })
    catalog = $catalog; release_minutes = 2880; teams = @($Admin, $HouseAccount)
  }
}
$initArgs | ConvertTo-Json -Compress -Depth 5 | Set-Content -Encoding ascii $init
Write-Host "factory code sha256 $(Get-Sha256Hex $wasm)"
Invoke-Near transaction construct-transaction $Admin $Factory add-action create-account add-action transfer "$($Net.fund.factory) NEAR" add-action deploy-contract use-file $wasm with-init-call new file-args $init prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' skip network-config $Network sign-with-keychain
Remove-Item $init
Remove-Scratch
