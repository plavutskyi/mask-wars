# By-hand rehearsal of a drain on a race from before sealed rounds (race-0003 on testnet): the mask's own key, from the
# keychain (login-key.ps1), signs both calls through the safe's planted hole. A sealed round counts only a plan sealed in
# its commit window and revealed after; this script seals nothing, so its drain never wins one, and on a safe locked to
# a sealed round the safe refuses it. set_owner makes the mask the owner; sweep sends -Near (1.5 NEAR unless given) to
# the mask. The CLI prints each transaction's hash: the sweep's hash goes to claim-drain.ps1. Open the race first: a
# drain before it does not count. This is the race itself: afterwards the safe holds less than min_loot. The owner
# chooses "send" twice.
#   .\drain.ps1 -Mask nova.tinygif8324.testnet                    # safe-0001 of the admin
#   .\drain.ps1 -Network mainnet -Mask nova.maskwars.near -Safe safe-0001.maskwars.near -Near 0.6 -DryRun
param([Parameter(Mandatory = $true)][string]$Mask, [string]$Safe, [string]$Near = '1.5', [string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
if (-not $Safe) { $Safe = "safe-0001.$Admin" }
$owner = Get-ScratchFile 'drain-owner-args.json'
$sweep = Get-ScratchFile 'drain-sweep-args.json'
@{ new_owner = $Mask } | ConvertTo-Json -Compress | Set-Content -Encoding ascii $owner
@{ to = $Mask; amount = (ConvertTo-Yocto $Near) } | ConvertTo-Json -Compress | Set-Content -Encoding ascii $sweep
Invoke-Near contract call-function as-transaction $Safe set_owner file-args $owner prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as $Mask network-config $Network sign-with-keychain
Invoke-Near contract call-function as-transaction $Safe sweep file-args $sweep prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as $Mask network-config $Network sign-with-keychain
Remove-Item $owner, $sweep
Remove-Scratch
