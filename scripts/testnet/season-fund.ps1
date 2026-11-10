# Puts NEAR into the season treasury, for shares of it: it leaves as a round, into a safe or a bounty, and a bounty
# nobody won comes back. One day of the program in season-args.json takes safe_fund into the safe and prize into the
# bounty (on mainnet 1 + 0.5 NEAR). Anyone may fund it, the same way, from their own account. -Near defaults to, and may
# not pass, limits.fund_max of packages/network (50 NEAR on testnet, 10 on mainnet: six daily rounds). -Exit takes
# the sponsor's share back, which the treasury allows only while a change that waits 72 hours is pending. The owner
# chooses "send".
#   .\season-fund.ps1                         # limits.fund_max
#   .\season-fund.ps1 -Near 5
#   .\season-fund.ps1 -Exit                   # the share of $Admin, while a long change waits
#   .\season-fund.ps1 -Network mainnet -DryRun
param([string]$Near, [switch]$Exit, [string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
if ($Exit) {
  Invoke-Near contract call-function as-read-only $Season share_of json-args "{`"account_id`":`"$Admin`"}" network-config $Network now
  Invoke-Near contract call-function as-transaction $Season exit json-args '{}' prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as $Admin network-config $Network sign-with-keychain
  exit
}
if (-not $Near) { $Near = $Net.limits.fund_max }
Assert-Limit "funding of $Near NEAR" (ConvertTo-Yocto $Near) $Net.limits.fund_max
Invoke-Near contract call-function as-transaction $Season fund json-args '{}' prepaid-gas '30.0 Tgas' attached-deposit "$Near NEAR" sign-as $Admin network-config $Network sign-with-keychain
Invoke-Near contract call-function as-read-only $Season next json-args '{}' network-config $Network now
