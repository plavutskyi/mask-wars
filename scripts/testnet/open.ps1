# Opens the sandbox bounty in open-args.json with 0.11 NEAR: at least 0.1 NEAR stays for the winner after the bounty
# pays for its storage. The bounty names the masks that may win it (whatever a run reports, the contract pays only one
# of them) and the judge it agrees to, the one in judge-args.json: if the contract's judge is another one, nothing opens.
# The judge then reads only a `Live race` run made after this, on a commit in main, with the GitHub token of the judge's
# OutLayer project. Season 0 on mainnet races live safes only. The owner chooses "send".
#   .\open.ps1 -Network mainnet -DryRun
param([string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
$file = Get-ScratchFile 'open-args.json'
$bounty = Read-Input 'open-args.json'
$bounty | Add-Member -NotePropertyName judge_version -NotePropertyValue (Read-Input 'judge-args.json').version
$bounty | ConvertTo-Json -Compress | Set-Content -Encoding ascii $file
Invoke-Near contract call-function as-transaction $Bounty open file-args $file prepaid-gas '30.0 Tgas' attached-deposit '0.11 NEAR' sign-as $Admin network-config $Network sign-with-keychain
Remove-Item $file
Remove-Scratch
