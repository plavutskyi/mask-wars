# Changes the season treasury the only way it can be changed: the admin ($Admin) proposes, the proposal waits in the
# open, then anyone applies it. One change at a time. A change not applied within 24 hours of being ready lapses. While a
# change that waits 72 hours is pending, every sponsor may take its share back (season-fund.ps1 -Exit).
#   .\season-change.ps1 -Show                  # the whole season: limits, program, treasury, what is pending
#   .\season-change.ps1 -Next                  # the next round: when, on what, for how much
#   .\season-change.ps1 -Program               # the program in season-args.json (judge from judge-args.json); 72 h,
#                                              # or 1 h when only the schedule, the hours and the windows change
#   .\season-change.ps1 -AllowSafe             # a safe code rounds may be made from (-Wasm, default live-safe); 72 h
#   .\season-change.ps1 -Limits                # limits.season of packages/network/<network>.json; 72 h if any goes up,
#                                              # 1 h if none does
#   .\season-change.ps1 -NewScheduler <account> # 1 h
#   .\season-change.ps1 -Code                  # the treasury in .scratch\near\maskwars_season.wasm; 72 h
#   .\season-change.ps1 -Cancel                # the admin withdraws the pending change
#   .\season-change.ps1 -Apply                 # after the wait: anything but code
#   .\season-change.ps1 -Upgrade               # after the wait: deploys the proposed code and runs migrate in one go
#   .\season-change.ps1 -Network mainnet -Show
# A new safe code (a new live-safe): -AllowSafe, wait 72 h, -Apply, then season-publish.ps1, then -Program with the new
# wasm in .scratch, wait 72 h, -Apply. The bounty contract must know the code too (bounty-change.ps1 -AllowSafe), and
# the judge the program names must be the bounty contract's. A first season is simplest deployed with the new code
# already in season-args.json: season-deploy.ps1 takes it as it is, with no wait. The owner chooses "send".
param([switch]$Show, [switch]$Next, [switch]$Program, [switch]$AllowSafe, [string]$Wasm = 'maskwars_live_safe.wasm', [switch]$Limits, [string]$NewScheduler, [switch]$Code, [switch]$Cancel, [switch]$Apply, [switch]$Upgrade, [string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
Assert-Account 'the new scheduler' $NewScheduler
$file = Get-ScratchFile 'season-change-args.json'
function Propose($change) {
  @{ change = $change } | ConvertTo-Json -Depth 10 -Compress | Set-Content -Encoding ascii $file
  Invoke-Near contract call-function as-transaction $Season propose file-args $file prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as $Admin network-config $Network sign-with-keychain
  Remove-Item $file
}
function Call($method) {
  Invoke-Near contract call-function as-transaction $Season $method json-args '{}' prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as $Admin network-config $Network sign-with-keychain
}
if ($Show) {
  Invoke-Near contract call-function as-read-only $Season season json-args '{}' network-config $Network now
} elseif ($Next) {
  Invoke-Near contract call-function as-read-only $Season next json-args '{}' network-config $Network now
} elseif ($Program) {
  $p = Get-SeasonProgram
  Assert-Limit "the program's bounty" $p.prize $Net.limits.season.max_prize
  foreach ($t in $p.targets) { Assert-Limit "the safe of $($t.challenge)" $t.safe_fund $Net.limits.season.max_safe_fund }
  Propose ([ordered]@{ kind = 'program'; program = $p })
} elseif ($AllowSafe) {
  Propose ([ordered]@{ kind = 'allow_safe'; code_hash = (Get-CodeHash (Get-Artifact $Wasm)) })
} elseif ($Limits) {
  Propose ([ordered]@{ kind = 'limits'; limits = (Get-SeasonLimits) })
} elseif ($NewScheduler) {
  Propose ([ordered]@{ kind = 'scheduler'; account = $NewScheduler })
} elseif ($Code) {
  Propose ([ordered]@{ kind = 'code'; sha256 = (Get-Sha256Hex (Get-Artifact 'maskwars_season.wasm')) })
} elseif ($Cancel) {
  Call 'cancel'
} elseif ($Apply) {
  Call 'apply'
} elseif ($Upgrade) {
  # The wasm itself is the call's input; the treasury checks its sha256 against the proposal.
  $seasonWasm = Get-Artifact 'maskwars_season.wasm'
  Write-Host "upgrade to code sha256 $(Get-Sha256Hex $seasonWasm)"
  Invoke-Near contract call-function as-transaction $Season upgrade file-args $seasonWasm prepaid-gas '300.0 Tgas' attached-deposit '0 NEAR' sign-as $Admin network-config $Network sign-with-keychain
} else {
  Write-Error 'say what to change: -Show, -Next, -Program, -AllowSafe, -Limits, -NewScheduler, -Code, -Cancel, -Apply or -Upgrade'; exit 1
}
Remove-Scratch
