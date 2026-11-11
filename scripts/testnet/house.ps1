# The house: a plain account ($HouseAccount: house.tinygif8324.testnet, house.maskwars.near on mainnet) that opens one
# sealed round a day on one safe, the vault, and takes back what the round leaves. The NEAR goes round: the house puts
# it into the vault and the round's bounty, the mask that wins takes it, and it comes home for the next round. The house
# is the team of those rounds and nothing more: it has no say over the bounty contract or the masks.
#
#   .\house.ps1                 # makes the account under $Admin with fund.house of packages/network; its full key goes
#                               # to the keychain and stays there: it signs the day by hand (retire.ps1,
#                               # safe-deploy.ps1 -House, open-safe.ps1 -House) and removes the hot key. "send" once
#   .\house.ps1 -Collect        # winnings home: each of the arena's own masks sends the house what it holds above
#                               # round.mask_keep (0.4 NEAR: storage and the gas a claim buys up front), signed by the
#                               # mask's full key from the keychain. "send" once per mask that has something to send
#   .\house.ps1 -HotKey         # a second full key for the house, for the Season workflow, so the day runs with nobody
#                               # signing. Its secret half lands in house-key.txt in .scratch (.scratch\near-mainnet on
#                               # mainnet): the owner pastes it into the secret HOUSE_KEY of the GitHub environment
#                               # `season-mainnet` (`season` on testnet; Deployment branches: main only) and deletes
#                               # the file. "send" once
#   .\house.ps1 -DropHotKey     # deletes that key from the house's account, signed by the key in the keychain: the
#                               # one in house-key.public.txt, or -Key ed25519:... "send" once
#   .\house.ps1 -Show           # what the chain says now: what the house holds, and which steps of the day are left
#   .\house.ps1 -Network mainnet -DryRun
#
# What the hot key can do, plainly: a NEAR account cannot make an account, deploy code or attach a deposit with a
# function-call key, so the house's day needs a full key. Whoever holds HOUSE_KEY can spend everything the house holds,
# and nothing else of the arena's. The scripts never bring the house above limits.house_max of packages/network. The
# key cannot change the bounty contract, touch a mask, or move the vault while a round is on: the vault holds no key
# and retires only once its round is over, and then only to the house. Without the hot key everything works by hand.
param([switch]$Collect, [switch]$HotKey, [switch]$DropHotKey, [string]$Key, [switch]$Show, [string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
$helper = Join-Path $PSScriptRoot 'house.mjs'
if ($Show) {
  $plan = Get-HousePlan
  $holds = if ($plan.house_free) { "holds $($plan.house_free) free" } else { 'is not on chain yet' }
  $stands = switch ($plan.vault_on_chain) { 'none' { 'is not on chain' } 'armed' { 'is on chain, with a round' } default { 'is on chain, without a round' } }
  Write-Host "On $Network`: $HouseAccount $holds; $Vault $stands."
  if ($plan.note) { Write-Host $plan.note -ForegroundColor Yellow }
  if ($plan.why) { Write-Host $plan.why }
  foreach ($s in @($plan.steps)) { Write-Host "  - $($s.text)" }
  if ($plan.stop) { Write-Host "then no round opens: $($plan.stop)" -ForegroundColor Yellow }
  Remove-HousePlan
  exit 0
}
if ($Collect) {
  $sample = @(if ($DryRun) { '--sample' })
  $home_ = Invoke-Node $helper 'collect' @sample | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or -not $home_) { Write-Error 'nothing was sent (the line above says why)'; exit 1 }
  if (@($home_.transfers).Count -eq 0) { Write-Host "No mask holds 0.01 NEAR or more above the $($home_.keep) NEAR it keeps: nothing to send home."; exit 0 }
  Write-Host "$HouseAccount holds $($home_.holds) NEAR and will hold $($home_.after) NEAR."
  foreach ($t in @($home_.transfers)) {
    Write-Host "$($t.account) holds $($t.holds) NEAR, keeps $($home_.keep) and sends $($t.near) home"
    Invoke-Near tokens $t.account send-near $HouseAccount $t.near network-config $Network sign-with-keychain
    if ($LASTEXITCODE -ne 0) { Write-Host "$($t.account): not sent"; exit 1 }
  }
  exit 0
}
if ($HotKey) {
  $file = Get-ScratchFile 'house-key.txt'
  $public = Invoke-Node $helper 'key' $file
  if ($LASTEXITCODE -ne 0 -or -not $public) { exit 1 }
  Write-Host "a full-access key for $HouseAccount`: $public"
  Invoke-Near account add-key $HouseAccount grant-full-access use-manually-provided-public-key $public network-config $Network sign-with-keychain
  if ($DryRun) {
    Write-Host 'Dry run: the key above is a throwaway one from a temporary file, now deleted.'
    Remove-Scratch
  } elseif ($LASTEXITCODE -eq 0) {
    Write-Host "HOUSE_KEY: paste the contents of $file into the secret of the environment 'season$GhEnvSuffix' (Settings, Environments; never a repository secret), then delete the file."
    Write-Host "Whoever holds it can spend what $HouseAccount holds. To take it back: .\house.ps1 -DropHotKey -Network $Network"
  }
  exit $LASTEXITCODE
}
if ($DropHotKey) {
  $public = Get-ScratchFile 'house-key.public.txt'
  if (-not $Key -and (Test-Path $public)) { $Key = (Get-Content $public -Raw).Trim() }
  if ($DryRun -and -not $Key) { $Key = 'ed25519:<the public half of the hot key>' }
  if (-not $DryRun -and $Key -cnotmatch '^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$') {
    Write-Error "which key? -Key ed25519:... (near account list-keys $HouseAccount network-config $Network now shows them)"
    exit 1
  }
  Invoke-Near account delete-keys $HouseAccount public-keys $Key network-config $Network sign-with-keychain
  if ($LASTEXITCODE -eq 0 -and -not $DryRun) { Write-Host "Now delete the secret HOUSE_KEY of the environment 'season$GhEnvSuffix' too: it signs nothing any more." }
  Remove-Scratch
  exit $LASTEXITCODE
}
Assert-Limit "the house's $($Net.fund.house) NEAR" (ConvertTo-Yocto $Net.fund.house) $Net.limits.house_max
Invoke-Near account create-account fund-myself $HouseAccount "$($Net.fund.house) NEAR" autogenerate-new-keypair save-to-keychain sign-as $Admin network-config $Network sign-with-keychain
if (-not $DryRun -and $LASTEXITCODE -eq 0) {
  Write-Host "Back the key up offline: near account export-account $HouseAccount using-private-key network-config $Network"
  Write-Host 'Next: house.ps1 -Collect brings the masks'' spare NEAR home; season-keys.ps1 -Safe gives the masks their key on the vault.'
}
