# Changes the rules of the bounty contract the only way it can be changed: the admin ($Admin) proposes, the proposal
# waits in the open, then anyone applies it. One change at a time; `-Show` prints what is pending. A change not applied
# within 24 hours of being ready lapses. After a new judge, judge-args.json must name it too, or open.ps1 and
# open-safe.ps1 open nothing.
#   .\bounty-change.ps1 -Show
#   .\bounty-change.ps1 -Judge <sha256>     # judge for new bounties; waits 1 h. Register it first: judge-pin.ps1
#   .\bounty-change.ps1 -AllowSafe          # the live safe in .scratch\near\maskwars_live_safe.wasm; waits 1 h
#   .\bounty-change.ps1 -DropSafe <hash>    # takes a safe code off the list at once: no new round runs on it
#   .\bounty-change.ps1 -Code               # the contract in .scratch\near\maskwars_bounty.wasm; waits 108 h while
#                                           # any bounty is live, 1 h with none; no bounty opens meanwhile
#   .\bounty-change.ps1 -NewAdmin <account> # waits like code
#   .\bounty-change.ps1 -Cancel             # the admin withdraws the pending change
#   .\bounty-change.ps1 -Apply              # after the wait: a judge, a safe or an admin
#   .\bounty-change.ps1 -Upgrade            # after the wait: deploys the proposed code and runs migrate in one go
#   .\bounty-change.ps1 -Network mainnet -Show
# Before -Upgrade check that no claim is with the judge (`get_terms` shows `judging`): migrate keeps such a claim, but
# an older contract's answer format is the one thing an upgrade must not change. The owner chooses "send".
param([switch]$Show, [string]$Judge, [switch]$AllowSafe, [string]$DropSafe, [switch]$Code, [string]$NewAdmin, [switch]$Cancel, [switch]$Apply, [switch]$Upgrade, [string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
Assert-Account 'the new admin' $NewAdmin
$file = Get-ScratchFile 'bounty-change-args.json'
function Propose($change) {
  @{ change = $change } | ConvertTo-Json -Compress | Set-Content -Encoding ascii $file
  Invoke-Near contract call-function as-transaction $Bounty propose file-args $file prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as $Admin network-config $Network sign-with-keychain
  Remove-Item $file
}
if ($Show) {
  Invoke-Near contract call-function as-read-only $Bounty governance json-args '{}' network-config $Network now
} elseif ($Judge) {
  Propose @{ kind = 'judge'; version = $Judge }
} elseif ($AllowSafe) {
  Propose @{ kind = 'allow_safe'; code_hash = (Get-CodeHash (Get-Artifact 'maskwars_live_safe.wasm')) }
} elseif ($DropSafe) {
  @{ code_hash = $DropSafe } | ConvertTo-Json -Compress | Set-Content -Encoding ascii $file
  Invoke-Near contract call-function as-transaction $Bounty drop_safe_code file-args $file prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as $Admin network-config $Network sign-with-keychain
  Remove-Item $file
} elseif ($Code) {
  Propose @{ kind = 'code'; sha256 = (Get-Sha256Hex (Get-Artifact 'maskwars_bounty.wasm')) }
} elseif ($NewAdmin) {
  Propose @{ kind = 'admin'; account = $NewAdmin }
} elseif ($Cancel) {
  Invoke-Near contract call-function as-transaction $Bounty cancel json-args '{}' prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as $Admin network-config $Network sign-with-keychain
} elseif ($Apply) {
  Invoke-Near contract call-function as-transaction $Bounty apply json-args '{}' prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as $Admin network-config $Network sign-with-keychain
} elseif ($Upgrade) {
  # The wasm itself is the call's input; the contract checks its sha256 against the proposal.
  $wasm = Get-Artifact 'maskwars_bounty.wasm'
  Write-Host "upgrade to code sha256 $(Get-Sha256Hex $wasm)"
  Invoke-Near contract call-function as-transaction $Bounty upgrade file-args $wasm prepaid-gas '300.0 Tgas' attached-deposit '0 NEAR' sign-as $Admin network-config $Network sign-with-keychain
} else {
  Write-Error 'say what to change: -Show, -Judge, -AllowSafe, -DropSafe, -Code, -NewAdmin, -Cancel, -Apply or -Upgrade'; exit 1
}
Remove-Scratch
