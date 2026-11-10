# Returns the expired bounty -Id (the one in refund-args.json unless given) to its owner, with what is left of its
# storage reserve. It works only 12 hours after the deadline and with no claim with the judge. The owner chooses "send".
#   .\refund.ps1
#   .\refund.ps1 -Network mainnet -Id human-0001 -DryRun
param([string]$Id, [string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
$file = Get-ScratchFile 'refund-args.json'
if (-not $Id) { $Id = (Read-Input 'refund-args.json').id }
@{ id = $Id } | ConvertTo-Json -Compress | Set-Content -Encoding ascii $file
Invoke-Near contract call-function as-transaction $Bounty refund file-args $file prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as $Admin network-config $Network sign-with-keychain
Remove-Item $file
Remove-Scratch
