# Optional, testnet only. Brings the old bounty contract on tinygif8324.testnet (race-0001..0003) to the current code:
# the new code and `migrate` in one transaction keep every bounty, live race, round, seal and claimed drain; old bounties
# keep the judge the old contract had. That account holds the owner's key, so on it the delay of bounty-change.ps1
# protects nothing: new bounties go to the keyless contract (bounty-deploy.ps1). Upgrade only with no claim in flight.
# Mainnet has no contract from before the keyless one (older_bounty in packages/network/mainnet.json is empty), so
# there it says so and sends nothing. The wasm is the CI artifact `maskwars-bounty-wasm`, put next to near.exe. The
# owner chooses "send".
#   .\upgrade-old.ps1
#   .\upgrade-old.ps1 -Network mainnet -DryRun
param([string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
$old = @($Net.older_bounty)
if ($old.Count -eq 0) { Write-Host "$Network has no bounty contract from before $Bounty`: nothing to upgrade."; exit 0 }
Invoke-Near contract deploy $old[0] use-file (Get-Artifact 'maskwars_bounty.wasm') with-init-call migrate json-args '{}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config $Network sign-with-keychain
