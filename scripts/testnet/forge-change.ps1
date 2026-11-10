# Changes the mask factory the only way it can be changed: the admin ($Admin) proposes, the proposal waits in the open,
# then anyone applies it. Once any mask is forged a change waits 72 h, before the first one 1 h; a change nobody applies
# lapses a day after it is ready.
#   .\forge-change.ps1 -Show                     # settings, the catalog and what is pending
#   .\forge-change.ps1 -StrategyKey x25519:<hex>  # the mind's key from the brain module on OutLayer
#   .\forge-change.ps1 -Keeper <account>          # who arms masks for races and settles them
#   .\forge-change.ps1 -Teams a.testnet,b.testnet # the teams whose rounds masks are armed for (the whole list)
#   .\forge-change.ps1 -Code                      # new factory code: maskwars_masks.wasm in .scratch (CI artifact)
#   .\forge-change.ps1 -Upgrade                   # after the wait: the same wasm, with migrate in the same batch
#   .\forge-change.ps1 -Cancel                    # the admin withdraws the pending change
#   .\forge-change.ps1 -Apply                     # after the wait
#   .\forge-change.ps1 -Network mainnet -Show
# The owner chooses "send".
param([switch]$Show, [string]$StrategyKey, [string]$Keeper, [string[]]$Teams, [switch]$Code, [switch]$Upgrade, [switch]$Cancel, [switch]$Apply, [string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
Assert-Account 'the keeper' $Keeper
Assert-Account 'the team' $Teams
$file = Get-ScratchFile 'forge-change-args.json'
function Propose($change) {
  @{ change = $change } | ConvertTo-Json -Compress -Depth 4 | Set-Content -Encoding ascii $file
  Invoke-Near contract call-function as-transaction $Factory propose file-args $file prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as $Admin network-config $Network sign-with-keychain
  Remove-Item $file
}
if ($Show) {
  Invoke-Near contract call-function as-read-only $Factory config json-args '{}' network-config $Network now
} elseif ($StrategyKey) {
  Propose @{ kind = 'strategy_key'; key = $StrategyKey }
} elseif ($Keeper) {
  Propose @{ kind = 'keeper'; account = $Keeper }
} elseif ($Teams) {
  Propose @{ kind = 'teams'; accounts = @($Teams) }
} elseif ($Code) {
  # The factory keeps the wasm's sha256; `upgrade` later takes exactly these bytes.
  Propose @{ kind = 'code'; sha256 = (Get-Sha256Hex (Get-Artifact 'maskwars_masks.wasm')) }
} elseif ($Upgrade) {
  Invoke-Near contract call-function as-transaction $Factory upgrade file-args (Get-Artifact 'maskwars_masks.wasm') prepaid-gas '300.0 Tgas' attached-deposit '0 NEAR' sign-as $Admin network-config $Network sign-with-keychain
} elseif ($Cancel) {
  Invoke-Near contract call-function as-transaction $Factory cancel json-args '{}' prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as $Admin network-config $Network sign-with-keychain
} elseif ($Apply) {
  Invoke-Near contract call-function as-transaction $Factory apply json-args '{}' prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as $Admin network-config $Network sign-with-keychain
} else {
  Write-Error 'say what to change: -Show, -StrategyKey, -Keeper, -Teams, -Code, -Upgrade, -Cancel or -Apply'; exit 1
}
Remove-Scratch
