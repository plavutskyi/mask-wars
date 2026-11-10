# Changes the jobs contract the only way it can be changed: the admin ($Admin) proposes, the proposal waits in the open
# (an hour; new code a week while any job is live), then anyone applies it. A change applies to jobs opened after it.
#   .\jobs-change.ps1 -Show                                    # settings, judges, what is pending
#   .\jobs-change.ps1 -Judge tee_tests -Version <sha256> -Key x25519:<hex>   # the judge of a kind, project $Admin/tests
#   .\jobs-change.ps1 -Judge ai_review -Version <sha256> -Key x25519:<hex>   # project $Admin/review
#   .\jobs-change.ps1 -Cancel                                  # the admin withdraws the pending change
#   .\jobs-change.ps1 -Apply                                   # after the wait
#   .\jobs-change.ps1 -Network mainnet -Judge tee_tests -Version <sha256> -Key x25519:<hex> -DryRun
# The version is the judge wasm's sha256 as OutLayer keys it, the key the one its `{"action":"key"}` run answered
# (services/judge-tests/README.md). The owner chooses "send".
param([switch]$Show, [ValidateSet('tee_tests', 'ai_review')][string]$Judge, [string]$Version, [string]$Key, [switch]$Cancel, [switch]$Apply, [string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
$file = Get-ScratchFile 'jobs-change-args.json'
if ($Show) {
  Invoke-Near contract call-function as-read-only $Jobs config json-args '{}' network-config $Network now
} elseif ($Judge) {
  if ($Version -notmatch '^[0-9a-f]{64}$' -or $Key -notmatch '^x25519:[0-9a-f]{64}$') { Write-Error '-Version <sha256, 64 hex> and -Key x25519:<64 hex>'; exit 1 }
  $project = if ($Judge -eq 'tee_tests') { "$Admin/tests" } else { "$Admin/review" }
  @{ change = [ordered]@{ kind = 'judge'; judge = [ordered]@{ kind = $Judge; project = $project; version = $Version; key = $Key } } } | ConvertTo-Json -Compress -Depth 5 | Set-Content -Encoding ascii $file
  Invoke-Near contract call-function as-transaction $Jobs propose file-args $file prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as $Admin network-config $Network sign-with-keychain
  Remove-Item $file
} elseif ($Cancel) {
  Invoke-Near contract call-function as-transaction $Jobs cancel_change json-args '{}' prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as $Admin network-config $Network sign-with-keychain
} elseif ($Apply) {
  Invoke-Near contract call-function as-transaction $Jobs apply json-args '{}' prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as $Admin network-config $Network sign-with-keychain
} else {
  Write-Error 'say what to change: -Show, -Judge, -Cancel or -Apply'; exit 1
}
Remove-Scratch
