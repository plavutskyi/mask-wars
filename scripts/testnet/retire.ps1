# Ends the house's finished round and brings its NEAR home: the first of the three scripts of a day by hand
# (retire.ps1, safe-deploy.ps1 -House, open-safe.ps1 -House). The house ($HouseAccount: house.tinygif8324.testnet,
# house.maskwars.near on mainnet) opens one sealed round a day on one safe, the vault ($Vault). Once that round is over
# the vault deletes its own account and gives its whole balance, the stake its code locked included, back to the house
# (`retire`): only the vault's team, the house, may call it, and the vault itself asks the bounty contract how the round
# ended before it goes. A round a mask won retires after its deadline; a round nobody won, after its bounty is refunded.
#
# The script reads the chain (Get-HousePlan in config.ps1) and sends only what is left, each a transaction signed by
# the house's key from the keychain:
#   - a mask that runs home (contracts/home) and holds winnings sends everything above what it keeps to the house
#     (`home`, which anyone may call and which pays only the house); a mask without home is said and skipped;
#   - a claim the judge never answered is dropped (`unstick`), a confirmed winner nobody paid yet is paid (`settle`), a
#     bounty nobody won goes back to the house (`refund`): whichever the round needs, usually none;
#   - `retire`.
# A round that is not over yet is said as that and nothing is sent. Run it again any time: what the chain already shows
# is not sent twice. The owner chooses "send" for each transaction.
#
# -Force sends `retire` whatever the plan says, for a vault that was made and never got its round (a safe without a
# round retires at once). The vault decides for itself: while its round is not over it refuses, and nothing changes.
#   .\retire.ps1
#   .\retire.ps1 -Network mainnet
#   .\retire.ps1 -Network mainnet -Force
#   .\retire.ps1 -Network mainnet -DryRun
param([switch]$Force, [string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
if ($Force) {
  Write-Host "retire: $Vault deletes itself and gives its whole balance back to $HouseAccount, if its round is over or it has none"
  Invoke-Near contract call-function as-transaction $Vault retire json-args '{}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' sign-as $HouseAccount network-config $Network sign-with-keychain
  exit $LASTEXITCODE
}
$closing = @('home', 'unstick', 'settle', 'refund', 'retire')
# The masks this run called home() on: house-open.ts --plan leaves them out (HOUSE_SKIP_HOME), so a home() that did not
# go through stops nothing. Cleared when the script ends, however it ends.
$env:HOUSE_SKIP_HOME = ''
try {
  for ($i = 0; $i -lt 20; $i++) {
    $plan = Get-HousePlan
    $step = @($plan.steps)[0]
    if ($plan.kind -eq 'race') {
      Write-Host "$($plan.why). Nothing retires while a round is on."
      break
    }
    if ($plan.vault_on_chain -eq 'none' -and $step.kind -ne 'home') {
      Write-Host "$Vault is not on chain: nothing to retire. Next: safe-deploy.ps1 -House, then open-safe.ps1 -House."
      break
    }
    if (-not $step -or $step.kind -notin $closing) {
      if ($plan.kind -eq 'steps') {
        # A vault an earlier run made and no round was opened on: it is right as it is.
        Write-Host "$Vault is on chain, right and without a round: nothing to retire. Next: open-safe.ps1 -House."
        break
      }
      Write-Host $plan.why
      Remove-HousePlan
      exit 1
    }
    if ($plan.note) { Write-Host $plan.note -ForegroundColor Yellow }
    Write-Host $step.text
    Invoke-Near contract call-function as-transaction $step.receiver $step.method file-args $step.args_file prepaid-gas $step.gas attached-deposit '0 NEAR' sign-as $HouseAccount network-config $Network sign-with-keychain
    if ($step.kind -eq 'home') {
      # Once per mask: whether its winnings came home or not, the plan leaves it out from now on and the day goes on.
      if ($LASTEXITCODE -ne 0) { Write-Host "home on $($step.mask) did not go through: its winnings stay with it, and the day goes on" -ForegroundColor Yellow }
      $env:HOUSE_SKIP_HOME = (@($env:HOUSE_SKIP_HOME -split ',' | Where-Object { $_ }) + $step.mask) -join ','
      if ($DryRun) { break }
      continue
    }
    if ($LASTEXITCODE -ne 0) { Write-Host 'Not sent: nothing changed.'; Remove-HousePlan; exit 1 }
    if ($DryRun) { break }
    $after = Wait-HouseStep $step
    if ($step.kind -eq 'retire') {
      Write-Host "$Vault is gone and its balance is back on $HouseAccount, which now holds $($after.house_free) free."
      if ($after.kind -eq 'steps' -and -not $after.stop) { Write-Host 'Next: safe-deploy.ps1 -House, then open-safe.ps1 -House.' }
      else { Write-Host "No round can open yet: $($after.stop)$($after.why)" -ForegroundColor Yellow }
      break
    }
  }
} finally {
  Remove-Item Env:HOUSE_SKIP_HOME -ErrorAction SilentlyContinue
}
Remove-HousePlan
