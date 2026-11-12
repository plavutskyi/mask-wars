# Locks the bond of each of our masks on job -Job, signed by $Admin: the one money move of a job a mask cannot make,
# since its key on the jobs contract attaches no NEAR. The `Jobs` workflow takes the job with a mask only once its bond
# waits there. Each bond is the job's own (`bond` in its terms) and its record's storage (0.004 NEAR), read from the
# chain; what the record does not take comes back at once. The bond comes back to $Admin when the job ends, all of it
# for a mask whose step counted, half for a seat that gave the job nothing, none for one the judge calls fake
# (contracts/jobs/README.md, the bond). The workflow's masks reveal their step in its window, so their bonds come back whole
# as long as a run reaches the job in that window (a reveal window of 30 minutes or more: the masks take no shorter).
# "send" once per mask. A bond of more than -Max NEAR a mask (0.5 unless given) is not locked.
#   .\jobs-bond.ps1 -Job break-safe-0005
#   .\jobs-bond.ps1 -Job break-safe-0005 -Masks onyx
#   .\jobs-bond.ps1 -Job break-safe-0005 -Unbond     # takes back the bonds of masks that have not taken the job
#   .\jobs-bond.ps1 -Job break-safe-0005 -Bond 0.01 -DryRun
param([string]$Job, [string[]]$Masks = @('nova', 'onyx', 'oracle'), [switch]$Unbond, [string]$Bond, [string]$Max = '0.5', [string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
if ($Job -notmatch '^[a-z0-9_-]{1,64}$') { Write-Error '-Job: the job id, 1 to 64 lowercase letters, digits, - or _'; exit 1 }
$helper = Join-Path $PSScriptRoot 'jobs-keys.mjs'
$file = Get-ScratchFile 'jobs-bond-args.json'

if ($Unbond) {
  foreach ($m in $Masks) {
    @{ id = $Job; mask = "$m.$Admin" } | ConvertTo-Json -Compress | Set-Content -Encoding ascii $file
    Invoke-Near contract call-function as-transaction $Jobs unbond file-args $file prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as $Admin network-config $Network sign-with-keychain
  }
  Remove-Item $file
  Remove-Scratch
  exit 0
}

# What one bond takes: the job's bond read from the chain, or for a dry run the -Bond given (nothing is read).
if ($DryRun) {
  if (-not $Bond) { Write-Error 'a dry run reads nothing from the chain: give the job''s bond with -Bond <NEAR>'; exit 1 }
  $deposit = Invoke-Node $helper '--deposit' (ConvertTo-Yocto $Bond)
  $bondYocto = ConvertTo-Yocto $Bond
} else {
  $b = Invoke-Node $helper '--bond' $Jobs $Job | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { exit 1 }
  if ($b.phase -ne 'enlisting') { Write-Error "$Job is $($b.phase): masks take a job only while it is enlisting, so no bond is locked"; exit 1 }
  if ($b.kind -ne 'drain') { Write-Host "$Job is a $($b.kind) job: the masks' minds do not seal work for its judge yet, so the workflow will not take it" -ForegroundColor Yellow }
  $deposit = $b.deposit
  $bondYocto = $b.bond
}
if ([System.Numerics.BigInteger]::Parse($bondYocto) -gt [System.Numerics.BigInteger]::Parse((ConvertTo-Yocto $Max))) {
  Write-Error "$Job asks a bond above $Max NEAR a mask: nothing was sent (give -Max to lock it anyway)"
  exit 1
}
Write-Host "$Job`: $deposit NEAR a mask (the bond and its record's storage), for $($Masks -join ', ')"
foreach ($m in $Masks) {
  @{ id = $Job; mask = "$m.$Admin" } | ConvertTo-Json -Compress | Set-Content -Encoding ascii $file
  Invoke-Near contract call-function as-transaction $Jobs bond file-args $file prepaid-gas '30.0 Tgas' attached-deposit "$deposit NEAR" sign-as $Admin network-config $Network sign-with-keychain
  if ($LASTEXITCODE -ne 0) { Write-Host "$m`: no bond locked on $Job" }
}
Remove-Item $file
Remove-Scratch
