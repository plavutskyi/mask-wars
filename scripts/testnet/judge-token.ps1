# Replaces the judge's GITHUB_TOKEN on OutLayer from the terminal, for when the wallet does not open on the dashboard.
# The token lets the judge read a sandbox race's run on GitHub; a live safe needs none, so season 0 on mainnet can do
# without it. Paste the token at the prompt. The script tests it on GitHub, seals it for the OutLayer of this network
# (the project $Admin/judge) and shows the transaction: the owner chooses "send".
#   .\judge-token.ps1
#   .\judge-token.ps1 -Network mainnet -DryRun
param([string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
$args_file = Get-ScratchFile 'store-secrets-args.json'
if ($DryRun) {
  Write-Host "A real run asks for the token, tests it on GitHub and seals it for $($Net.outlayer.api); here a stand-in argument file."
  @{ accessor = @{ Project = @{ project_id = "$Admin/judge" } }; profile = 'default'; encrypted_secrets_base64 = '<the token, sealed for OutLayer>'; access = @{ Whitelist = @{ accounts = @($Admin) } }; vault_id = $null } | ConvertTo-Json -Compress -Depth 5 | Set-Content -Encoding ascii $args_file
} else {
  $secure = Read-Host 'GitHub token' -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $env:MASK_JUDGE_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  node (Join-Path $PSScriptRoot 'judge-token.mjs') $args_file $Admin $Net.outlayer.api
  $ok = $LASTEXITCODE -eq 0
  Remove-Item Env:MASK_JUDGE_TOKEN
  if (-not $ok) { exit 1 }
}
Invoke-Near contract call-function as-transaction $Outlayer store_secrets file-args $args_file prepaid-gas '50.0 Tgas' attached-deposit '0.02 NEAR' sign-as $Admin network-config $Network sign-with-keychain
Remove-Item $args_file
Remove-Scratch
