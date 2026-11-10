# Publishes a safe's code on NEAR once, as a global contract by its hash: every safe the season makes from it only
# points at it, so a new safe costs its account and the NEAR it holds, not its code. NEAR burns 0.0001 NEAR a byte for a
# global contract (ten times plain storage; the CI job prints the price of each safe, about 15 NEAR for live-safe); the
# call attaches exactly that and 0.01 NEAR more, which comes back. It pays for itself after about ten rounds: a safe with
# its own copy of the code keeps about 1.55 NEAR of it for good. The treasury pays nothing, and it publishes only a code
# its program allows. The owner chooses "send".
#   .\season-publish.ps1                                        # maskwars_live_safe.wasm in .scratch
#   .\season-publish.ps1 -Network mainnet -DryRun
param([string]$Wasm = 'maskwars_live_safe.wasm', [string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
$file = Get-Artifact $Wasm
$bytes = if (Test-Path $file) { (Get-Item $file).Length } else { 0 }
$cost = [decimal]$bytes / 10000 + [decimal]0.01
$deposit = [string]::Format([System.Globalization.CultureInfo]::InvariantCulture, '{0} NEAR', $cost)
if ($bytes -eq 0) { Write-Host "dry run: $Wasm is not in $scratch yet, so the deposit below is only the 0.01 NEAR on top" }
Write-Host "publish $($Wasm): code hash $(Get-CodeHash $file), $bytes bytes, attach $deposit"
Invoke-Near contract call-function as-transaction $Season publish_code file-args $file prepaid-gas '300.0 Tgas' attached-deposit $deposit sign-as $Admin network-config $Network sign-with-keychain
