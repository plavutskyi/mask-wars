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
#   .\open-safe.ps1
#   .\open-safe.ps1 -Network mainnet -Near 0.5 -DryRun
param([string]$Near = '0.35', [string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
Assert-Limit "the round's deposit of $Near NEAR" (ConvertTo-Yocto $Near) $Net.limits.hand.deposit_max
$file = Get-ScratchFile 'open-safe-args.json'
$round = Read-Input 'open-safe-args.json'
$round | Add-Member -NotePropertyName safe_code -NotePropertyValue (Get-CodeHash (Get-Artifact 'maskwars_live_safe.wasm'))
$round | Add-Member -NotePropertyName judge_version -NotePropertyValue (Read-Input 'judge-args.json').version
$round | ConvertTo-Json -Compress | Set-Content -Encoding ascii $file
Invoke-Near contract call-function as-transaction $Bounty open_safe file-args $file prepaid-gas '100.0 Tgas' attached-deposit "$Near NEAR" sign-as $Admin network-config $Network sign-with-keychain
Remove-Item $file
Remove-Scratch
