# Puts a live safe on chain in one transaction that adds no key: create the account, fund it, deploy the code, call
# new(...). The account is born with no key at all, so nobody, the team included, ever moves its NEAR by hand; the same
# way the bounty contract was made (bounty-deploy.ps1). The safe is a training target and its hole is planted on
# purpose; only the masks listed in it can reach it. The wasm is the CI artifact `maskwars-live-safe-wasm`, put next
# to near.exe. The owner chooses "send" once.
#
# -House: the house's vault ($Vault of packages/network), the second of the three scripts of a day by hand (retire.ps1,
# safe-deploy.ps1 -House, open-safe.ps1 -House). The house signs, and the vault gets round.safe of packages/network
# (1.93 NEAR: about 1.65 is the stake its code and state lock, the rest is what the masks race for; all of it comes back
# when the vault retires). It owns itself, names the bounty contract as the one that locks it to its round and the house
# as the one team whose round it takes. The wasm is the file in apps/web/public/contracts named by the network's
# safe_code, the CI artifact in .scratch only when that file is not there. Before anything is sent the chain is read
# (Get-HousePlan in config.ps1): the wasm must hash to the network's safe_code (checked once more right before the
# deploy) and export retire, the bounty contract must list that code and name the judge of
# judge-args.json, yesterday's vault must be gone, and the house must hold enough for the vault and the round's deposit
# together, so a vault is never made without its round. After, the chain is read again: the account must run that code,
# hold no key, own itself and name the house as its team.
#
# Without -House: a safe for a round the admin opens by hand, safe-init-args.json, with fund.safe of packages/network
# (3 NEAR on testnet, 2.2 on mainnet: about 1.55 NEAR pays for its code, the rest is what masks race for, above the
# min_loot of open-safe-args.json). It owns itself, names the bounty contract as its arbiter and the admin as its team: a
# round anyone else opens on it does not lock it. Such a safe keeps the stake of its code for good, and a drained one
# holds less than min_loot, so every round by hand needs a fresh one. The season makes its own safes from global code
# (season-publish.ps1).
#
# -Variant, for a safe by hand only: the safe's kind (live-safe 1.7.0 on: owner, limit or pause; contracts/challenges/
# live-safe/README.md). It goes to `new` beside safe-init-args.json and stays for good; the safe's own `variant` view
# shows it, and a race on its round reads it there. Without -Variant nothing is added and the safe is of the owner
# kind, as every safe so far. The house's vault names no kind: -House with -Variant is refused.
# -Near, for a safe by hand only: what the safe gets in place of fund.safe, for a round on a small bank. The script
# says how much of it the safe's own storage locks (it comes back with `retire`) and how much is left to race for.
# -Safe, for a safe by hand: another account under $Admin than the one safe-init-args.json names; it is its own owner,
# with the file's masks, bounty contract and team. A drained safe keeps too little for a second round, so every round
# by hand gets a fresh name. When its round is over: retire.ps1 -Safe <the same name>.
#   .\safe-deploy.ps1                                # the safe safe-init-args.json names
#   .\safe-deploy.ps1 -House -Network mainnet        # the house's vault
#   .\safe-deploy.ps1 -Network mainnet -Safe pause-0001.maskwars.near -Variant pause -Near 2.2
#   .\safe-deploy.ps1 -Network mainnet -DryRun
param([string]$Safe, [switch]$House, [string]$Variant, [string]$Near, [string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
if ($Variant -and $Variant -cnotin @('owner', 'limit', 'pause')) { Write-Error "-Variant: owner, limit or pause, not '$Variant'"; exit 1 }
if ($House) {
  if ($Safe) { Write-Error "-House makes the house's vault, $Vault; -Safe names a safe of the admin's"; exit 1 }
  if ($Variant -or $Near) { Write-Error "-House makes the house's vault as packages/network says, of the owner kind; -Variant and -Near are for a safe by hand"; exit 1 }
  $plan = Get-HousePlan
  $steps = @($plan.steps)
  if ($plan.kind -eq 'race') { Write-Host "$($plan.why). The vault is on chain and its round is on."; Remove-HousePlan; exit 0 }
  if ($plan.kind -ne 'steps') { Write-Host "Nothing was sent: $($plan.why)" -ForegroundColor Yellow; Remove-HousePlan; exit 1 }
  # A dry run shows this script's own step of an ordinary day.
  $step = if ($DryRun) { $steps | Where-Object { $_.kind -eq 'create' } | Select-Object -First 1 } else { $steps[0] }
  if ($step.kind -eq 'open') { Write-Host "$Vault is already on chain, right and without a round. Next: open-safe.ps1 -House."; Remove-HousePlan; exit 0 }
  if ($step.kind -ne 'create') {
    $first = if ($step.kind -eq 'home') { "the masks' winnings come home first" } else { "yesterday's round still stands on $Vault" }
    Write-Host "Nothing was sent: $first. First: retire.ps1 ($($step.text))." -ForegroundColor Yellow
    Remove-HousePlan
    exit 1
  }
  $wasm = if ($step.wasm) { $step.wasm } else { Get-Artifact 'maskwars_live_safe.wasm' }
  # The file near.exe deploys, hashed again right before it goes: only the network's safe_code is ever deployed.
  $code = Get-CodeHash $wasm
  if ($code -cne $Net.safe_code) {
    if (-not $DryRun) {
      Write-Error "$wasm has code hash $code, not the network's safe_code $($Net.safe_code): nothing was sent"
      Remove-HousePlan
      exit 1
    }
    $named = if ($Net.safe_code) { $Net.safe_code } else { 'not set yet' }
    Write-Host "A real run deploys only a wasm whose code hash is the network's safe_code ($named); this one: $code." -ForegroundColor Yellow
  }
  Assert-Limit "the vault's $($step.near)" (ConvertTo-Yocto ($step.near -replace ' NEAR$', '')) $Net.limits.hand.safe_max
  if ($plan.note) { Write-Host $plan.note -ForegroundColor Yellow }
  Write-Host $step.text
  Write-Host "safe code sha256 $(Get-Sha256Hex $wasm), code hash $code"
  Invoke-Near transaction construct-transaction $HouseAccount $Vault add-action create-account add-action transfer $step.near add-action deploy-contract use-file $wasm with-init-call new file-args $step.args_file prepaid-gas $step.gas attached-deposit '0 NEAR' skip network-config $Network sign-with-keychain
  if ($LASTEXITCODE -ne 0) { Write-Host 'Not sent: nothing changed.'; Remove-HousePlan; exit 1 }
  if (-not $DryRun) {
    $after = Wait-HouseStep $step
    if ($after.kind -eq 'steps' -and @($after.steps)[0].kind -eq 'open') {
      Write-Host "$Vault is on chain and right: it runs the network's safe_code, holds no key, owns itself and its team is $HouseAccount."
      Write-Host 'Next: open-safe.ps1 -House.'
    } else {
      Write-Error "$Vault is not as it should be, and no round opens on it: $($after.note) $($after.stop) $($after.why)"
      Remove-HousePlan
      exit 1
    }
  }
  Remove-HousePlan
  exit 0
}
$wasm = Get-Artifact 'maskwars_live_safe.wasm'
$init = Read-Input 'safe-init-args.json'
# The arguments as the file holds them, unless -Safe names another account or -Variant a kind: then they go from a
# file of their own in .scratch, shown before the transaction.
$own = $false
Assert-Account 'the safe' $Safe
if ($Safe -and $init.owner -ne $Safe) {
  # Another safe than the file's, under its own name: it owns itself, as every safe of a round does.
  $init.owner = $Safe
  $own = $true
}
if (-not $Safe) { $Safe = $init.owner }
if ($init.owner -ne $Safe) { Write-Error "safe-init-args.json: the owner must be the safe itself, $Safe"; exit 1 }
if ($init.arbiter -ne $Bounty) { Write-Error "safe-init-args.json: the arbiter must be the bounty contract, $Bounty"; exit 1 }
if ($init.team -ne $Admin) { Write-Error "safe-init-args.json: the team must be the account that opens the round, $Admin"; exit 1 }
if (-not $Safe.EndsWith(".$Admin")) { Write-Error "$Safe is not an account under $Admin`: only its parent can make it in one transaction"; exit 1 }
$fund = if ($Near) { $Near } else { $Net.fund.safe }
Assert-Limit "the safe's $fund NEAR" (ConvertTo-Yocto $fund) $Net.limits.hand.safe_max
# What the safe's own storage locks: its code, and 6 000 bytes at most for its account and state, at 0.00001 NEAR a
# byte. The rest is what the masks race for; a round's min_loot (open-safe-args.json) must fit in it twice.
if (Test-Path $wasm) {
  $stake = [System.Numerics.BigInteger]::Multiply((Get-Item $wasm).Length + 6000, [System.Numerics.BigInteger]::Pow(10, 19))
  $bank = [System.Numerics.BigInteger]::Parse((ConvertTo-Yocto $fund)) - $stake
  # Twice the least drain any round may ask for (0.1 NEAR, the bounty contract's floor): a round's min_loot
  # (open-safe.ps1 -MinLoot, or open-safe-args.json) must still fit in what is left.
  $least = [System.Numerics.BigInteger]::Parse((ConvertTo-Yocto '0.2'))
  $milli = { param($y) ([decimal]([System.Numerics.BigInteger]::Divide($y, [System.Numerics.BigInteger]::Pow(10, 21)))) / 1000 }
  Write-Host "the safe gets $fund NEAR: about $(& $milli $stake) is the stake of its storage (back with retire), about $(& $milli $bank) is what the masks race for"
  if ($bank -lt $least) {
    Write-Error "$fund NEAR leaves about $(& $milli $bank) NEAR to race for, less than twice the least drain a round asks for (0.1 NEAR): nothing was sent"
    exit 1
  }
}
# The safe's kind goes to `new` beside the arguments of safe-init-args.json; with no -Variant and the file's own safe
# the file goes as it is.
$initFile = Get-Input 'safe-init-args.json'
if ($Variant) {
  $init | Add-Member -NotePropertyName variant -NotePropertyValue $Variant
  $own = $true
}
if ($own) {
  $initFile = Get-ScratchFile 'safe-init-args.json'
  $init | ConvertTo-Json -Compress | Set-Content -Encoding ascii $initFile
  $kind = if ($Variant) { $Variant } else { 'owner (none named)' }
  Write-Host "$Safe, kind $kind; new: $($init | ConvertTo-Json -Compress)"
}
Write-Host "safe code sha256 $(Get-Sha256Hex $wasm), code hash $(Get-CodeHash $wasm)"
Invoke-Near transaction construct-transaction $Admin $Safe add-action create-account add-action transfer "$fund NEAR" add-action deploy-contract use-file $wasm with-init-call new file-args $initFile prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' skip network-config $Network sign-with-keychain
if ($own -and (Test-Path $initFile)) { Remove-Item $initFile }
Remove-Scratch
