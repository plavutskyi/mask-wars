# Registers the admin account of the network, $Admin: maskwars.near on mainnet, the parent of every MASK WARS contract
# there. Only the holder of a parent account can create accounts under it, so whoever holds maskwars.near holds every
# name the arena uses (bounty., season., masks., jobs., crews., the safes): register it before anything else, and before
# anything public names it. A top-level name goes through the network's registrar (`near` on mainnet): near.exe sends
# `create_account` there, signed by -Payer, an account of the owner's that already holds NEAR and whose key is in the
# keychain (login-key.ps1). The new account's full key is made here and goes to the keychain; back it up offline at once
# (`near account export-account`). -Near is what maskwars.near starts with: the registrar keeps about 0.002 NEAR for the
# account's storage, the rest is its balance. The rest of the season's budget (scripts/mainnet/README.md) can come later by a plain
# transfer from any wallet. The owner chooses "send".
#   .\register.ps1 -Network mainnet -Payer <owner's account> -DryRun
#   .\register.ps1 -Network mainnet -Payer <owner's account> -Near 1
param([Parameter(Mandatory = $true)][string]$Payer, [string]$Near = '1', [string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
$null = ConvertTo-Yocto $Near
Invoke-Near account create-account fund-myself $Admin "$Near NEAR" autogenerate-new-keypair save-to-keychain sign-as $Payer network-config $Network sign-with-keychain
Invoke-Near account view-account-summary $Admin network-config $Network now
