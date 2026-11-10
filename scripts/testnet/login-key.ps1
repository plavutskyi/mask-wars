# Imports an account into Windows Credential Manager from its private key (ed25519:...), for the network the CLI asks
# about: tinygif8324.testnet on testnet; on mainnet maskwars.near, and the account that pays for registering it
# (register.ps1). The owner runs this and pastes the key. near.exe: near-cli-rs, in .scratch\near\.
#   .\login-key.ps1
#   .\login-key.ps1 -Network mainnet -DryRun
param([string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
if ($DryRun) { Write-Host "near.exe asks for the private key, then the network: choose $Network." }
Invoke-Near account import-account using-private-key
