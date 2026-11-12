# The masks' keys on the jobs market, from the same seeds they race with (jobs-keys.mjs, packages/race/src/keys.ts):
# for each mask one function-call key on the jobs contract ($Jobs: enlist, step, reveal, leave, judge, settle, close,
# unstick; 2 NEAR of gas: about 30 jobs for the mask that judges and settles them, 0.07 NEAR each, many more for the
# others) and one on the crews contract ($Crews: join, leave, enlist; 1 NEAR of gas: a crew's enlisting prepays 150
# TGas, and the allowance does not get the unspent gas back, so 0.25 NEAR lasted only about 16 enlistings). Neither
# attaches NEAR, so neither moves the mask's money: the bond a mask takes a job with is locked by jobs-bond.ps1. The
# `Jobs` workflow derives the private halves from MASK_KEYS, so nothing new goes into any secret. The masks' full keys
# stay in the keychain.
#
# The seeds are the ones season-keys.ps1 wrote, in .scratch (mask-seeds.json, the contents of MASK_KEYS): this script
# never makes a seed. Both keys of a mask go in one transaction: "send" once per mask (near.exe 0.30 takes at most 3
# actions of a transaction on its command line). The chain refuses the whole transaction when either key is on the mask
# already, and the mask keeps what it had: the script says so and goes on with the next mask (-Masks names the ones to
# do again).
#
# -Crew, once the keys are on: the captain (-Captain, ORACLE unless given) forms the crew with every mask named, each a
# striker, the whole reward to the strikers: whoever of them breaks the round, the crew is paid and the strikers with a
# counted step share it. The deposit pays the crew's storage (0.05 NEAR; what it does not take comes back). Every other
# mask joins on its own with its key on the crews contract, in the workflow's first pass. Then set the repository
# variable JOBS_CREW to the crew's id: from then on the masks take a job together when all of them can.
#   .\jobs-keys.ps1                              # nova, onyx, oracle
#   .\jobs-keys.ps1 -Masks onyx
#   .\jobs-keys.ps1 -Crew arena-trio -CrewOnly   # the crew alone, the keys are on already
#   .\jobs-keys.ps1 -Crew arena-trio -DryRun
param([string[]]$Masks = @('nova', 'onyx', 'oracle'), [string]$Crew, [string]$Captain = 'oracle', [switch]$CrewOnly, [string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
if ($CrewOnly -and -not $Crew) { Write-Error '-CrewOnly goes with -Crew'; exit 1 }
if ($Crew -and $Crew -notmatch '^[a-z0-9-]{3,32}$') { Write-Error '-Crew: 3 to 32 lowercase letters, digits or -'; exit 1 }
if ($Crew -and ($Captain -notin $Masks)) { Write-Error "-Captain $Captain is not one of -Masks"; exit 1 }
if ($Crew -and $Masks.Count -lt 2) { Write-Error 'a crew is 2 to 8 masks'; exit 1 }
$seeds = Get-ScratchFile 'mask-seeds.json'
if ($DryRun) {
  # A dry run reads no seed of the owner's: throwaway seeds in a temporary file show the shape of every call.
  $tmp = [ordered]@{}
  foreach ($m in $Masks) {
    $b = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
    $tmp[$m.ToUpperInvariant()] = @{ seed = ([System.BitConverter]::ToString($b) -replace '-', '').ToLowerInvariant() }
  }
  $tmp | ConvertTo-Json -Compress | Set-Content -Encoding ascii $seeds
}
$public = Invoke-Node (Join-Path $PSScriptRoot 'jobs-keys.mjs') $seeds $Jobs $Crews @Masks | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { exit 1 }
$failed = @()

if (-not $CrewOnly) {
  foreach ($m in $Masks) {
    $account = "$m.$Admin"
    $k = $public.$m
    Write-Host "$($account): keys on $Jobs and $Crews"
    $cmd = @('transaction', 'construct-transaction', $account, $account)
    $cmd += @('add-action', 'add-key', 'grant-function-call-access', '--allowance', '2 NEAR', '--contract-account-id', $Jobs, '--function-names', 'enlist, step, reveal, leave, judge, settle, close, unstick', 'use-manually-provided-public-key', $k.jobs)
    $cmd += @('add-action', 'add-key', 'grant-function-call-access', '--allowance', '1 NEAR', '--contract-account-id', $Crews, '--function-names', 'join, leave, enlist', 'use-manually-provided-public-key', $k.crews)
    $cmd += @('skip', 'network-config', $Network, 'sign-with-keychain')
    Invoke-Near @cmd
    if ($LASTEXITCODE -ne 0) { Write-Host "$($account): these keys were not added (a key already on the mask refuses both)"; $failed += $m }
  }
}

if ($Crew) {
  $file = Get-ScratchFile 'crew-form-args.json'
  $members = @(@($Captain) + @($Masks | Where-Object { $_ -ne $Captain }) | ForEach-Object { [ordered]@{ mask = "$_.$Admin"; role = 'striker' } })
  [ordered]@{ id = $Crew; members = $members; split = [ordered]@{ scout = 0; striker = 10000; verifier = 0 } } | ConvertTo-Json -Compress -Depth 4 | Set-Content -Encoding ascii $file
  Write-Host "$Captain.$Admin forms crew $Crew on $Crews"
  Invoke-Near contract call-function as-transaction $Crews form file-args $file prepaid-gas '100.0 Tgas' attached-deposit '0.05 NEAR' sign-as "$Captain.$Admin" network-config $Network sign-with-keychain
  if ($LASTEXITCODE -ne 0) { Write-Host "crew $Crew was not formed"; exit 1 }
  Remove-Item $file
  Write-Host "JOBS_CREW: set the repository variable of the public repo to $Crew. The other masks join in the Jobs workflow's next pass."
}
Remove-Scratch
if ($failed.Count -gt 0) { Write-Host "no keys added for: $($failed -join ', ')"; exit 1 }
