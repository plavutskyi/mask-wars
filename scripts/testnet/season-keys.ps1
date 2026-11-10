# Race keys of the masks for the season, all from one seed per mask (season-keys.mjs, packages/race/src/keys.ts). Each
# round races on a new safe, s0001, s0002, … under $Season, and NEAR gives a function-call key exactly one
# receiver, so every mask gets its keys ahead of time: one on the bounty contract (commit, reveal, claim_drain, settle;
# 10 NEAR of gas, about 38 wins) and one on each of the next safes (the library's methods, 0.5 NEAR of gas). None
# attaches NEAR, so none moves the mask's own money; the race derives the private half it needs from the seed. The
# masks' full keys stay in the keychain and never race.
#
# near.exe builds a transaction of at most 4 actions, so the keys go in groups of 4: "send" 4 times per mask for the
# default 14 safes. The seeds land in mask-seeds.json in .scratch (.scratch\near-mainnet on mainnet: never the
# testnet seeds), in the shape of the secret MASK_KEYS of the
# `live-race` environment: {"NOVA":{"seed":"…"},…}. The owner pastes it there and KEEPS the file: the keys for later
# safes come from the same seeds. Next to it, mask-seeds.public.json holds each mask's key on the bounty contract, in
# the shape of the repository variable MASK_CLAIM_KEYS: the race job seals the winning finding only for that key.
#
# -Rotate, after a leak of MASK_KEYS or of the seeds file: new seeds for the masks named, their new keys on the bounty
# contract and on the safes from -From to -To, and once those are on chain every function-call key the mask held before
# is deleted, so nothing an old seed gives opens a finding or plays a round. Give -From the next safe the season makes
# (season-change.ps1 -Next shows its number). The full key stays.
#   .\season-keys.ps1                          # s0001..s0014 and the bounty contract, for nova, onyx, oracle
#   .\season-keys.ps1 -From 15 -To 28          # two more weeks; the bounty key is already there
#   .\season-keys.ps1 -Masks onyx -From 1 -To 14
#   .\season-keys.ps1 -Rotate -From 9 -To 22   # new seeds from s0009 on, the old keys deleted
#   .\season-keys.ps1 -Network mainnet -DryRun
param([string[]]$Masks = @('nova', 'onyx', 'oracle'), [int]$From = 1, [int]$To = 14, [switch]$Rotate, [string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
$file = Get-ScratchFile 'mask-seeds.json'
$methods = (Read-Input 'season-args.json').safe_methods
$rotateArg = @(if ($Rotate) { '--rotate' })
$public = Invoke-Node (Join-Path $PSScriptRoot 'season-keys.mjs') @rotateArg $file $Season $Bounty $From $To @Masks | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { exit 1 }
foreach ($m in $Masks) {
  $account = "$m.$Admin"
  # A rotation reads the keys the mask holds now: they go once all the new ones are on chain. A dry run reads nothing.
  $old = @()
  if ($Rotate -and $DryRun) {
    Write-Host "$account`: a real run reads its function-call keys here and deletes them after the new ones"
  } elseif ($Rotate) {
    $old = @(Invoke-Node (Join-Path $PSScriptRoot 'mask-keys.mjs') '--function-call-keys' $account)
    if ($LASTEXITCODE -ne 0) { exit 1 }
  }
  $keys = @()
  if ($From -eq 1 -or $Rotate) {
    $keys += [pscustomobject]@{ to = $Bounty; allowance = '10 NEAR'; methods = 'commit, reveal, claim_drain, settle'; key = $public.$m.bounty }
  }
  foreach ($s in $public.$m.safes) {
    $keys += [pscustomobject]@{ to = $s.safe; allowance = '0.5 NEAR'; methods = $methods; key = $s.key }
  }
  for ($i = 0; $i -lt $keys.Count; $i += 4) {
    $cmd = @('transaction', 'construct-transaction', $account, $account)
    $names = @()
    for ($j = $i; $j -lt [Math]::Min($i + 4, $keys.Count); $j++) {
      $k = $keys[$j]
      $cmd += @('add-action', 'add-key', 'grant-function-call-access', '--allowance', $k.allowance, '--contract-account-id', $k.to, '--function-names', $k.methods, 'use-manually-provided-public-key', $k.key)
      $names += $k.to
    }
    $cmd += @('skip', 'network-config', $Network, 'sign-with-keychain')
    Write-Host "$($account): keys for $($names -join ', ')"
    Invoke-Near @cmd
    if ($LASTEXITCODE -ne 0) { Write-Host "$($account): these keys were not added; the old keys stay"; exit 1 }
  }
  if ($Rotate -and $old.Count -gt 0) {
    Write-Host "$($account): deleting the old race keys $($old -join ', ')"
    Invoke-Near account delete-keys $account public-keys ($old -join ',') network-config $Network sign-with-keychain
  }
}
if ($DryRun) {
  Write-Host "Dry run: the keys above come from throwaway seeds in a temporary file, now deleted. A real run keeps $(Join-Path $scratch 'mask-seeds.json')."
  Remove-Scratch
} else {
  Write-Host "MASK_KEYS: paste the contents of $file into the secret of the environment 'live-race$GhEnvSuffix'. Keep the file: later safes take keys from the same seeds."
  Write-Host "$ClaimKeysVar`: paste the contents of $($file -replace '\.json$', '.public.json') into the repository variable."
}
