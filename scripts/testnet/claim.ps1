# Asks the judge on OutLayer whether the Live race run in claim-args.json broke the bounty. 0.02 NEAR pays for the
# claim's storage and the judge's run (the unused part comes back); 200 TGas fits a small balance. Claims do not wait
# for each other, and one may come up to 12 hours after the deadline. The owner chooses "send".
#   .\claim.ps1 -Network mainnet -DryRun
param([string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
Invoke-Near contract call-function as-transaction $Bounty claim file-args (Get-Input 'claim-args.json') prepaid-gas '200.0 Tgas' attached-deposit '0.02 NEAR' sign-as $Admin network-config $Network sign-with-keychain
