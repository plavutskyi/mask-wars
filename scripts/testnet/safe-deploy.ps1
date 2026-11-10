# Puts a live safe on chain by hand: creates the account with fund.safe of packages/network (3 NEAR on testnet, 2.2 on
# mainnet: about 1.55 NEAR pays for its 154 KB of code, the rest is what masks race for, above the min_loot of
# open-safe-args.json), then deploys the safe and calls new(...) with safe-init-args.json, where the safe owns itself,
# names the bounty contract as the one that locks it to its round (`arbiter`) and the admin as the one team whose round it
# takes (`team`): a round anyone else opens on it does not lock it. Until open-safe.ps1 opens the round, nobody moves the
# safe; then nobody moves it before the commit window closes, and after that each mask that sealed a plan has it to itself
# for one turn, in the order of the seals. A drained safe holds less than min_loot, so every round gets a fresh one:
# safe-0001 was race-0003. The safe is a training target and its hole is planted on purpose. Only the masks listed
# there can reach it. The safe drops the key that deployed it, so after this nobody, the team included, moves its NEAR
# by hand. The season makes its own safes from global code (season-publish.ps1): this script is for a round by hand. The
# wasm is the CI artifact `maskwars-live-safe-wasm`, put next to near.exe. The owner chooses "send" twice.
#   .\safe-deploy.ps1                                # the safe safe-init-args.json names
#   .\safe-deploy.ps1 -Network mainnet -DryRun
param([string]$Safe, [string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
$wasm = Get-Artifact 'maskwars_live_safe.wasm'
$init = Read-Input 'safe-init-args.json'
if (-not $Safe) { $Safe = $init.owner }
if ($init.owner -ne $Safe) { Write-Error "safe-init-args.json: the owner must be the safe itself, $Safe"; exit 1 }
if ($init.arbiter -ne $Bounty) { Write-Error "safe-init-args.json: the arbiter must be the bounty contract, $Bounty"; exit 1 }
if ($init.team -ne $Admin) { Write-Error "safe-init-args.json: the team must be the account that opens the round, $Admin"; exit 1 }
Assert-Limit "the safe's $($Net.fund.safe) NEAR" (ConvertTo-Yocto $Net.fund.safe) $Net.limits.hand.safe_max
Invoke-Near account create-account fund-myself $Safe "$($Net.fund.safe) NEAR" autogenerate-new-keypair save-to-keychain sign-as $Admin network-config $Network sign-with-keychain
Invoke-Near contract deploy $Safe use-file $wasm with-init-call new file-args (Get-Input 'safe-init-args.json') prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' network-config $Network sign-with-keychain
