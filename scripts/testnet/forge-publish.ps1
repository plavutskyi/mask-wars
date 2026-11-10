# Publishes the mask code as a global contract, once, by its hash: the call's input is maskwars_mask.wasm itself, and the
# factory takes only the code whose sha256 it was given in new(...). The factory pays NEAR's price, 0.0001 NEAR a byte
# (about 5 NEAR). From then on every forged mask points at this code instead of storing its own copy, and the forge
# opens. The owner chooses "send".
#   .\forge-publish.ps1 -Network mainnet -DryRun
param([string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
$mask = Get-Artifact 'maskwars_mask.wasm'
Write-Host "mask code sha256 $(Get-Sha256Hex $mask)"
Invoke-Near contract call-function as-transaction $Factory publish_mask_code file-args $mask prepaid-gas '300.0 Tgas' attached-deposit '0 NEAR' sign-as $Admin network-config $Network sign-with-keychain
Invoke-Near contract call-function as-read-only $Factory config json-args '{}' network-config $Network now
