# Opens the sealed round in open-safe-args.json with the deposit -Near (0.35 NEAR unless given; RULES.md): about 0.12
# NEAR is set aside for the storage the three masks may take (what is left goes back at the end), and the rest is the
# bounty. The deposit may not pass limits.hand.deposit_max of packages/network. For the first commit_minutes the masks
# only seal the hashes of their plans; for reveal_minutes after that they play and reveal. The earliest seal whose plan
# moved at least min_loot out of the safe to its mask wins. The round names the safe's code: the code hash of the live
# safe in .scratch (the one safe-deploy.ps1 put on chain), which the bounty contract must know, and the judge the round
# agrees to, the one in judge-args.json: if the contract's judge is another one, nothing opens. The safe must be its own
# owner, let in exactly the round's masks and name this bounty contract as its arbiter and $Admin, who signs this, as
# its team (safe-init-args.json): the contract locks the safe to the round in the same call, and a safe that does not
# lock takes no round (the whole deposit comes back at once). Start the `Live race` right after this, so the race ends
# inside the commit window. The owner chooses "send".
#
# -House: the house's daily round on its vault, the third of the three scripts of a day by hand (retire.ps1,
# safe-deploy.ps1 -House, open-safe.ps1 -House). The house signs. Everything about the round comes from packages/network
# (`round`: the deposit, min_loot, the windows) and from the chain (Get-HousePlan in config.ps1): its id is the first
# race-<n> no bounty contract of the arena holds, the vault must be on chain and right, and the bounty contract must
# list its code and name the judge of judge-args.json. -Near does not apply. Right after it, start the race: Actions,
# Season, Run workflow finds the round open and races it.
#
# -Id, -Safe, -MinLoot, for a round by hand: the round's id, its safe and the least drain that counts (NEAR), in place
# of what open-safe-args.json holds; the masks and the windows stay the file's. A round by hand on a safe made with
# safe-deploy.ps1 -Safe ... -Variant ... is opened so, under an id of its own (8 to 64 letters, digits, - or _; not
# race-<n>, the house's own row of daily rounds). The house's round takes none of them.
#   .\open-safe.ps1
#   .\open-safe.ps1 -House -Network mainnet
#   .\open-safe.ps1 -Network mainnet -Near 0.5 -DryRun
#   .\open-safe.ps1 -Network mainnet -Id pause-0001 -Safe pause-0001.maskwars.near -MinLoot 0.1 -Near 0.25
param([string]$Near = '0.35', [switch]$House, [string]$Id, [string]$Safe, [string]$MinLoot, [string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
if ($House -and ($Id -or $Safe -or $MinLoot)) { Write-Error "-House opens the house's round as packages/network says; -Id, -Safe and -MinLoot are for a round by hand"; exit 1 }
if ($Id -and $Id -cnotmatch '^[A-Za-z0-9_-]{8,64}$') { Write-Error "-Id: 8 to 64 letters, digits, - or _, not '$Id'"; exit 1 }
if ($Id -cmatch '^race-\d+$') { Write-Error "-Id: race-<n> is the house's row of daily rounds; a round by hand takes an id of its own, not '$Id'"; exit 1 }
Assert-Account 'the safe' $Safe
if ($House) {
  $plan = Get-HousePlan
  $steps = @($plan.steps)
  if ($plan.kind -eq 'race') {
    Write-Host "$($plan.why)"
    Write-Host "Now: Actions -> Season -> Run workflow (or Live race: challenge $($plan.round.challenge), bounty $($plan.round.id))."
    Remove-HousePlan
    exit 0
  }
  if ($plan.kind -ne 'steps') { Write-Host "Nothing was sent: $($plan.why)" -ForegroundColor Yellow; Remove-HousePlan; exit 1 }
  # A dry run shows this script's own step of an ordinary day.
  $step = if ($DryRun) { $steps | Where-Object { $_.kind -eq 'open' } | Select-Object -First 1 } else { $steps[0] }
  if ($step.kind -ne 'open') {
    Write-Host "Nothing was sent: the vault is not ready for a round yet. First: $($step.text) (retire.ps1, then safe-deploy.ps1 -House)." -ForegroundColor Yellow
    Remove-HousePlan
    exit 1
  }
  Assert-Limit "the round's deposit of $($step.deposit)" (ConvertTo-Yocto ($step.deposit -replace ' NEAR$', '')) $Net.limits.hand.deposit_max
  if ($plan.note) { Write-Host $plan.note -ForegroundColor Yellow }
  Write-Host $step.text
  Invoke-Near contract call-function as-transaction $Bounty open_safe file-args $step.args_file prepaid-gas $step.gas attached-deposit $step.deposit sign-as $HouseAccount network-config $Network sign-with-keychain
  if ($LASTEXITCODE -ne 0) { Write-Host 'Not sent: nothing changed.'; Remove-HousePlan; exit 1 }
  if (-not $DryRun) {
    $after = Wait-HouseStep $step
    if ($after.kind -ne 'race') {
      Write-Error "round $($step.id) did not open on $Vault (the transaction above says why; a safe that would not lock gives the whole deposit back): $($after.note) $($after.stop) $($after.why)"
      Remove-HousePlan
      exit 1
    }
    Write-Host "Round $($after.round.id) is open on $Vault and its masks seal their plans."
    Write-Host "Now: Actions -> Season -> Run workflow (or Live race: challenge $($after.round.challenge), bounty $($after.round.id))."
  }
  Remove-HousePlan
  exit 0
}
Assert-Limit "the round's deposit of $Near NEAR" (ConvertTo-Yocto $Near) $Net.limits.hand.deposit_max
$file = Get-ScratchFile 'open-safe-args.json'
$round = Read-Input 'open-safe-args.json'
if ($Id) { $round.id = $Id }
if ($Safe) { $round.safe = $Safe }
if ($MinLoot) { $round.min_loot = ConvertTo-Yocto $MinLoot }
$round | Add-Member -NotePropertyName safe_code -NotePropertyValue (Get-CodeHash (Get-Artifact 'maskwars_live_safe.wasm'))
$round | Add-Member -NotePropertyName judge_version -NotePropertyValue (Read-Input 'judge-args.json').version
$round | ConvertTo-Json -Compress | Set-Content -Encoding ascii $file
Invoke-Near contract call-function as-transaction $Bounty open_safe file-args $file prepaid-gas '100.0 Tgas' attached-deposit "$Near NEAR" sign-as $Admin network-config $Network sign-with-keychain
Remove-Item $file
Remove-Scratch
