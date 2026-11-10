# Gives the arena's own masks their accounts: nova, onyx and oracle under $Admin (packages/network: `masks`), with
# fund.mask NEAR each (0.2 on testnet, 0.5 on mainnet: storage and the gas a claim buys up front). Each account's full
# key goes to the keychain, so claim-drain.ps1 signs as the mask by hand.
# Then each mask gets two race keys. NEAR lets such a key call one contract only and never attach NEAR, so:
#   - on the round's safe (-Safe), set_owner and sweep: playing the plan;
#   - on the bounty contract, commit, reveal, claim_drain and settle: the sealed round (RULES.md). The bounty pays the
#     storage of a seal and the judge of a mask's first claim.
# Neither key can move the mask's own NEAR. NEAR buys a call's gas up front at 0.001 NEAR per TGas and takes it off the
# key's allowance for good, so 0.5 NEAR is about 33 calls on the safe (each gets 15 TGas, and a mask plays only when the
# allowance covers its whole plan) and 1 NEAR is about 3 rounds of commit, reveal and claim (30 + 30 + 200 TGas); the
# unused gas goes back to the mask's balance. Their secret halves land in mask-keys.json in .scratch (.scratch\near on
# testnet, .scratch\near-mainnet on mainnet), already in the shape of the secret MASK_KEYS of the live-race environment
# (never a repository secret: Live race stops if it finds one); the public halves of the keys on the bounty contract land
# in mask-keys.public.json next to it, in the shape of the repository variable MASK_CLAIM_KEYS: the race job seals a
# finding only for a key on that list. The owner pastes both, then deletes the secret file. The season races with keys
# from seeds instead (season-keys.ps1).
# A rotation takes the old keys away: once the new keys are on chain, every function-call key the mask held before is
# deleted, so a key that was ever exposed opens no sealed finding and plays no round. The full key stays.
#   .\masks.ps1                         # new accounts and keys for all three: "send" three times per mask
#   .\masks.ps1 -KeysOnly               # accounts exist: new keys for a new safe and the bounty contract, the old ones
#                                       # deleted: "send" three times per mask
#   .\masks.ps1 -KeysOnly -Masks onyx   # one again; the others in mask-keys.json keep their keys
#   .\masks.ps1 -AccountsOnly           # the accounts alone, for the season: its keys come from season-keys.ps1
#   .\masks.ps1 -Network mainnet -AccountsOnly -DryRun
param([string[]]$Masks = @('nova', 'onyx', 'oracle'), [string]$Safe, [switch]$KeysOnly, [switch]$AccountsOnly, [string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
if (-not $Safe) { $Safe = (Read-Input 'safe-init-args.json').owner }
$keys = Get-ScratchFile 'mask-keys.json'
if (-not $KeysOnly) {
  foreach ($m in $Masks) {
    Invoke-Near account create-account fund-myself "$m.$Admin" "$($Net.fund.mask) NEAR" autogenerate-new-keypair save-to-keychain sign-as $Admin network-config $Network sign-with-keychain
  }
}
if ($AccountsOnly) {
  Write-Host "The accounts only: the season's race keys come from season-keys.ps1."
  exit 0
}
$public = Invoke-Node (Join-Path $PSScriptRoot 'mask-keys.mjs') $keys @Masks | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { exit 1 }
foreach ($m in $Masks) {
  $account = "$m.$Admin"
  # The function-call keys the mask holds before this rotation: read first, deleted once the new ones are on chain. A
  # dry run reads nothing from the chain and only says so.
  $old = @()
  if ($DryRun) {
    if ($KeysOnly) { Write-Host "$account`: a real run reads its function-call keys here and deletes them after the new ones" }
  } else {
    $old = @(Invoke-Node (Join-Path $PSScriptRoot 'mask-keys.mjs') '--function-call-keys' $account)
    if ($LASTEXITCODE -ne 0) { exit 1 }
  }
  # The old keys go only once both new ones are on chain: a cancelled or failed add stops here, keys untouched.
  Invoke-Near account add-key $account grant-function-call-access '--allowance' '0.5 NEAR' '--contract-account-id' $Safe '--function-names' 'set_owner, sweep' use-manually-provided-public-key $public.$m.safe network-config $Network sign-with-keychain
  if ($LASTEXITCODE -ne 0) { Write-Host "$account`: the safe key was not added, the old keys stay"; exit 1 }
  Invoke-Near account add-key $account grant-function-call-access '--allowance' '1 NEAR' '--contract-account-id' $Bounty '--function-names' 'commit, reveal, claim_drain, settle' use-manually-provided-public-key $public.$m.claim network-config $Network sign-with-keychain
  if ($LASTEXITCODE -ne 0) { Write-Host "$account`: the bounty key was not added, the old keys stay"; exit 1 }
  if ($old.Count -gt 0) {
    Write-Host "$account`: deleting the old race keys $($old -join ', ')"
    Invoke-Near account delete-keys $account public-keys ($old -join ',') network-config $Network sign-with-keychain
  }
}
if ($DryRun) {
  Write-Host "Dry run: the keys above are throwaway ones from a temporary file, now deleted. A real run writes $(Join-Path $scratch 'mask-keys.json')."
  Remove-Scratch
} else {
  Write-Host "MASK_KEYS: paste the contents of $keys into the secret of the live-race environment (Settings, Environments), then delete the file."
  Write-Host "MASK_CLAIM_KEYS: paste the contents of $($keys -replace '\.json$', '.public.json') into the repository variable."
}
