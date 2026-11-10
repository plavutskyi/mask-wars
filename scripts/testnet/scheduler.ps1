# The scheduler: its own account ($Scheduler: scheduler.tinygif8324.testnet, scheduler.maskwars.near on mainnet), with
# fund.scheduler NEAR for gas, and one function-call key for open_next and collect on the season treasury. That key
# calls nothing else, attaches no NEAR and spends only the scheduler's own NEAR on gas: whoever holds it can only say
# "now", and the treasury opens a round only when one is due and within its limits; collect only brings finished rounds
# home to the treasury. The account's full key goes to the keychain, for topping it up or a new key. The secret half of
# the function-call key lands in scheduler-key.txt in .scratch (.scratch\near-mainnet on mainnet), in the form of the
# secret SCHEDULER_KEY of the GitHub environment `season` (Deployment branches: main only): the owner pastes it there
# and deletes the file. The owner chooses "send" twice.
#   .\scheduler.ps1               # the account and its key
#   .\scheduler.ps1 -KeyOnly      # a new key for the account that exists; remove the old one with near account delete-keys
#   .\scheduler.ps1 -Network mainnet -DryRun
param([switch]$KeyOnly, [string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
$file = Get-ScratchFile 'scheduler-key.txt'
if (-not $KeyOnly) {
  Invoke-Near account create-account fund-myself $Scheduler "$($Net.fund.scheduler) NEAR" autogenerate-new-keypair save-to-keychain sign-as $Admin network-config $Network sign-with-keychain
}
$public = Invoke-Node (Join-Path $PSScriptRoot 'scheduler-key.mjs') $file
if ($LASTEXITCODE -ne 0) { exit 1 }
Invoke-Near account add-key $Scheduler grant-function-call-access '--allowance' 'unlimited' '--contract-account-id' $Season '--function-names' 'open_next, collect' use-manually-provided-public-key $public network-config $Network sign-with-keychain
if ($DryRun) {
  Write-Host 'Dry run: the key above is a throwaway one from a temporary file, now deleted.'
  Remove-Scratch
} else {
  Write-Host "SCHEDULER_KEY: paste the contents of $file into the secret of the environment 'season$GhEnvSuffix' (Settings, Environments), then delete the file."
}
