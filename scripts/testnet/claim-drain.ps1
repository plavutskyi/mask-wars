# The mask asks the judge on OutLayer whether its own drain transaction -Tx emptied the safe of the round -Id (the round
# in open-safe-args.json unless given). In a sealed round the mask has already revealed its plan, and -Tx is that plan's
# sweep: this is the by-hand retry when the claim from the race did not go through. Only the mask can claim its drain,
# so it signs this with its own key from the keychain (login-key.ps1) and pays 0.02 NEAR for the judge's run (the unused
# part comes back). The judge reads that transaction from the chain; if it holds, the contract pays the mask itself.
# Claim soon after the drain: a regular RPC keeps transactions for a few epochs only (about 17 hours on mainnet's
# FastNEAR). The owner chooses "send".
#   .\claim-drain.ps1 -Tx <sweep transaction hash> -Mask nova.tinygif8324.testnet
#   .\claim-drain.ps1 -Network mainnet -Id s0-0001-3fa9c2 -Tx <hash> -Mask nova.maskwars.near -DryRun
param([Parameter(Mandatory = $true)][string]$Tx, [Parameter(Mandatory = $true)][string]$Mask, [string]$Id, [string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
Assert-Account 'the mask' $Mask
if (-not $Id) { $Id = (Read-Input 'open-safe-args.json').id }
$file = Get-ScratchFile 'claim-drain-args.json'
@{ id = $Id; tx_hash = $Tx } | ConvertTo-Json -Compress | Set-Content -Encoding ascii $file
Invoke-Near contract call-function as-transaction $Bounty claim_drain file-args $file prepaid-gas '200.0 Tgas' attached-deposit '0.02 NEAR' sign-as $Mask network-config $Network sign-with-keychain
Remove-Item $file
Remove-Scratch
