# The keeper of the people's masks: the factory's keeper is $Admin, and it signs arm, settle, note and share with one function-call
# key on its own account for the mask factory and nothing else. That key, and every race key the keeper puts on a
# person's mask, come from one seed (KEEPER_SEED). This script makes the seed once, in keeper-seed.txt in .scratch
# (.scratch\near-mainnet on mainnet; running it again keeps the same seed), and adds the keeper's key: receiver the
# factory, methods arm, settle, note and share (a race's sealed note for the readers its owner chose, view keys), 2 NEAR
# of gas allowance (an arm with its round check burns about 0.015 NEAR at most, a note far less).
# The key attaches no NEAR, so it cannot take a yocto from $Admin: it can arm a mask only for a round of the factory's
# teams that lists it (the factory asks the bounty contract first) and settle a race for at most what it held. The owner
# pastes the file's contents into the secret KEEPER_SEED of the environment `live-race` (Settings, Environments), then
# deletes the file. "send" once.
#   .\keeper-key.ps1
#   .\keeper-key.ps1 -Network mainnet -DryRun
param([string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
$file = Get-ScratchFile 'keeper-seed.txt'
$public = Invoke-Node (Join-Path $PSScriptRoot 'keeper-key.mjs') $file $Factory
if ($LASTEXITCODE -ne 0) { exit 1 }
Write-Host "the keeper's key on $Factory`: $public"
Invoke-Near account add-key $Admin grant-function-call-access '--allowance' '2 NEAR' '--contract-account-id' $Factory '--function-names' 'arm, settle, note, share' use-manually-provided-public-key $public network-config $Network sign-with-keychain
if ($DryRun) {
  Write-Host 'Dry run: the seed above is a throwaway one from a temporary file, now deleted.'
  Remove-Scratch
} else {
  Write-Host "KEEPER_SEED: paste the contents of $file into the secret of the environment 'live-race$GhEnvSuffix' (Settings, Environments), then delete the file."
}
