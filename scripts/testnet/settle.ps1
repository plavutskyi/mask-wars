# Pays the winner of the sealed round -Id (the round in open-safe-args.json unless given) when its payout had to wait:
# the judge confirmed a later seal while an earlier one could still win. Once the reveal window is over and no earlier
# claim is with the judge, or once the earlier seals were refused, anyone may call settle; the NEAR only goes to the
# winner. The season's own rounds are settled by the scheduler's collect. The owner chooses "send".
#   .\settle.ps1
#   .\settle.ps1 -Network mainnet -Id human-0001 -DryRun
param([string]$Id, [string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
if (-not $Id) { $Id = (Read-Input 'open-safe-args.json').id }
$file = Get-ScratchFile 'settle-args.json'
@{ id = $Id } | ConvertTo-Json -Compress | Set-Content -Encoding ascii $file
Invoke-Near contract call-function as-transaction $Bounty settle file-args $file prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as $Admin network-config $Network sign-with-keychain
Remove-Item $file
Remove-Scratch
