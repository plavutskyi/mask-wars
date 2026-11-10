# A sealed round with the people's masks beside NOVA, ONYX and ORACLE. The team ($Admin) opens it; the season's
# treasury stays as it is. human-round.mjs reads the mask factory and takes every forged mask that is ready to race.
# Then, each a transaction the owner sends:
#   1. the round's own live safe, h<NNNN>.$Admin, with one min_loot (0.5 NEAR) and 0.1 NEAR of margin on top of its
#      code, 2.2 NEAR in all, of which about 1.6 stays with its code for good: Live race seals one plan a run, so one
#      sweep is all that ever leaves it. It owns itself, lets in exactly the round's masks, names the bounty contract as
#      its arbiter and $Admin as its team, and drops the key that deployed it ("send" twice);
#   2. a key on that safe for each of NOVA, ONYX and ORACLE, from its seed in mask-seeds.json in .scratch (the file
#      season-keys.ps1 keeps): the drain job derives the same key if one of ours wins ("send" once a mask);
#   3. open_safe: round human-<NNNN>, commit window 60 minutes, a reveal window with 3 minutes for each mask's turn,
#      min_loot 0.5 NEAR ("send" once).
# Both amounts stay within limits.hand of packages/network/<network>.json, or nothing is sent.
# Right after, Actions -> Live race -> Run workflow: challenge live-safe, bounty human-<NNNN>. The workflow's arm job
# gives each person's mask its race keys (the factory checks the round first), the masks race, the winner seals and
# plays its plan in its own turn, and the settle job charges each mind what it really spent.
#   .\human-round.ps1 -N 1
#   .\human-round.ps1 -N 1 -Network mainnet -DryRun   # one stand-in person's mask, nothing read from the chain
param([Parameter(Mandatory = $true)][int]$N, [string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
$wasm = Get-Artifact 'maskwars_live_safe.wasm'
$dir = Split-Path (Get-ScratchFile 'human-round-args.json')
$sample = @(if ($DryRun) { '--sample' })
$info = Invoke-Node (Join-Path $PSScriptRoot 'human-round.mjs') $dir $N @sample | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { exit 1 }
Write-Host "round $($info.id) on $($info.safe): $($info.people.Count) of the people's masks: $($info.people -join ', ')"
Write-Host "the safe gets $($info.safeNear), the round's deposit is $($info.deposit)"
Assert-Limit "the safe's $($info.safeNear)" (ConvertTo-Yocto ($info.safeNear -replace ' NEAR$', '')) $Net.limits.hand.safe_max
Assert-Limit "the round's deposit of $($info.deposit)" (ConvertTo-Yocto ($info.deposit -replace ' NEAR$', '')) $Net.limits.hand.deposit_max
$safeArgs = Join-Path $dir 'human-safe-args.json'
$roundArgs = Join-Path $dir 'human-round-args.json'
Invoke-Near account create-account fund-myself $info.safe $info.safeNear autogenerate-new-keypair save-to-keychain sign-as $Admin network-config $Network sign-with-keychain
Invoke-Near contract deploy $info.safe use-file $wasm with-init-call new file-args $safeArgs prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' network-config $Network sign-with-keychain
$methods = (Read-Input 'season-args.json').safe_methods
foreach ($p in $info.ours.PSObject.Properties) {
  Write-Host "$($p.Name): a key on $($info.safe)"
  Invoke-Near account add-key $p.Name grant-function-call-access '--allowance' '0.5 NEAR' '--contract-account-id' $info.safe '--function-names' $methods use-manually-provided-public-key $p.Value network-config $Network sign-with-keychain
}
$round = Get-Content $roundArgs | ConvertFrom-Json
$round | Add-Member -NotePropertyName safe_code -NotePropertyValue (Get-CodeHash $wasm)
$round | Add-Member -NotePropertyName judge_version -NotePropertyValue (Read-Input 'judge-args.json').version
$round | ConvertTo-Json -Compress | Set-Content -Encoding ascii $roundArgs
Invoke-Near contract call-function as-transaction $Bounty open_safe file-args $roundArgs prepaid-gas '100.0 Tgas' attached-deposit $info.deposit sign-as $Admin network-config $Network sign-with-keychain
Remove-Item $safeArgs, $roundArgs
Remove-Scratch
Write-Host "Now: Actions -> Live race -> Run workflow, challenge live-safe, bounty $($info.id)."
