# Shared by every script here, on testnet and on mainnet. A script dot-sources this file after its own param(...),
# where it declares [string]$Network and [switch]$DryRun like every other script here.
#
# -Network picks the network: testnet (the default) or mainnet. Without it the scripts read $env:MASKWARS_NETWORK, the
# same variable the site reads. Everything that differs between the two lives in data, never in a script:
#   packages/network/<network>.json  accounts, endpoints, the NEAR each new account gets, the limits of small sums
#   scripts/testnet/*.json           what the testnet calls send (rounds, the season's program, judges)
#   scripts/mainnet/*.json           the same files for mainnet
#   .scratch/near/                   near.exe; testnet's CI artifacts and the files the scripts write
#   .scratch/near-mainnet/           mainnet's CI artifacts and the files the scripts write (keys, seeds): a mainnet
#                                    key never lands next to a testnet one
#
# Every transaction goes through Invoke-Near: near.exe shows it and asks what to do with it, and the owner chooses
# "send". With -DryRun nothing is signed, sent or read from the chain: each call is printed as near.exe would get it,
# with every file it reads (a JSON argument in full, a wasm by its size and sha256), and the script goes on as if the
# owner had sent it. No key ever lives in this repository.
if (-not $Network) { $Network = if ($env:MASKWARS_NETWORK) { $env:MASKWARS_NETWORK } else { 'testnet' } }
if ($Network -cnotin @('testnet', 'mainnet')) { Write-Error "-Network: testnet or mainnet, not '$Network'"; exit 1 }
$Net = Get-Content (Join-Path $PSScriptRoot "..\..\packages\network\$Network.json") -Raw | ConvertFrom-Json
# Not $near: PowerShell names are case-blind, and a script's -Near amount would overwrite it.
$NearCli = Join-Path $PSScriptRoot '..\..\.scratch\near\near.exe'
$scratch = Join-Path $PSScriptRoot $(if ($Network -eq 'mainnet') { '..\..\.scratch\near-mainnet' } else { '..\..\.scratch\near' })
$inputs = if ($Network -eq 'mainnet') { Join-Path $PSScriptRoot '..\mainnet' } else { $PSScriptRoot }
if (-not (Test-Path $scratch)) { New-Item -ItemType Directory -Force $scratch | Out-Null }

# The accounts, all from packages/network/<network>.json. The contracts live on accounts of their own that hold no key
# (bounty-deploy.ps1, season-deploy.ps1, forge-deploy.ps1, jobs-deploy.ps1). $Admin proposes every change to them, the
# change waits in the open, then anyone applies it.
$Admin = $Net.admin
$Bounty = $Net.bounty
$Season = $Net.season
$Scheduler = $Net.scheduler
$Factory = $Net.factory
$Jobs = $Net.jobs
$Crews = $Net.crews
$Outlayer = $Net.outlayer.contract

# The GitHub names of this network (scripts/mainnet/README.md): mainnet keeps its keys in environments and a variable of its own,
# so one network's secrets never overwrite the other's.
$GhEnvSuffix = if ($Network -eq 'mainnet') { '-mainnet' } else { '' }
$ClaimKeysVar = if ($Network -eq 'mainnet') { 'MASK_CLAIM_KEYS_MAINNET' } else { 'MASK_CLAIM_KEYS' }

if ($DryRun) {
  Write-Host "DRY RUN on $Network`: nothing is signed or sent; every call below is what near.exe would get." -ForegroundColor Cyan
} elseif ($Network -eq 'mainnet') {
  Write-Host 'MAINNET: real NEAR. Choose "send" only for a transaction that matches scripts/mainnet/README.md.' -ForegroundColor Yellow
}

# One input of this network: scripts\testnet\<name> on testnet, scripts\mainnet\<name> on mainnet.
function Get-Input([string]$Name) { Join-Path $inputs $Name }

# Reads an input as JSON.
function Read-Input([string]$Name) { Get-Content (Get-Input $Name) -Raw | ConvertFrom-Json }

# A file a script writes: in .scratch for a real run; in a temporary folder for a dry run, so a dry run never touches the
# owner's keys, seeds or arguments. Remove-Scratch deletes what a dry run wrote.
function Get-ScratchFile([string]$Name) {
  if (-not $DryRun) { return Join-Path $scratch $Name }
  if (-not $script:dryDir) {
    $script:dryDir = Join-Path ([System.IO.Path]::GetTempPath()) "maskwars-dry-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force $script:dryDir | Out-Null
  }
  Join-Path $script:dryDir $Name
}
function Remove-Scratch { if ($script:dryDir -and (Test-Path $script:dryDir)) { Remove-Item -Recurse -Force $script:dryDir } }

# NEAR as a decimal string ("0.35") → yoctoNEAR as a decimal string, as the contracts take amounts.
function ConvertTo-Yocto([string]$Near) {
  if ($Near -notmatch '^(0|[1-9]\d{0,8})(\.(\d{1,24}))?$') { throw "not an amount of NEAR: $Near" }
  $frac = if ($Matches[3]) { $Matches[3].PadRight(24, '0') } else { '0' }
  ([System.Numerics.BigInteger]::Parse($Matches[1]) * [System.Numerics.BigInteger]::Pow(10, 24) + [System.Numerics.BigInteger]::Parse($frac)).ToString()
}

# Stops before anything is sent when an amount is above its limit in packages/network/<network>.json.
function Assert-Limit([string]$What, [string]$Yocto, [string]$LimitNear) {
  if ([System.Numerics.BigInteger]::Parse($Yocto) -gt [System.Numerics.BigInteger]::Parse((ConvertTo-Yocto $LimitNear))) {
    Write-Error "$What is above the $Network limit of $LimitNear NEAR (packages/network/$Network.json): nothing was sent"
    exit 1
  }
}

# Stops before anything is sent when an account typed by hand is not this network's: a name ending in .testnet is a
# testnet account and nothing else is, the rule of packages/network (onNetwork). A contract without a key keeps the
# account it was told for good.
function Assert-Account([string]$What, [string[]]$Accounts) {
  foreach ($a in $Accounts) {
    if (-not $a) { continue }
    $wellFormed = $a -cmatch '^[a-z0-9]+([._-][a-z0-9]+)*$' -and $a.Length -ge 2 -and $a.Length -le 64
    $isTestnet = $a.EndsWith('.testnet')
    if (-not $wellFormed -or (($Network -eq 'testnet') -ne $isTestnet)) {
      Write-Error "$What '$a' is not a $Network account: nothing was sent"
      exit 1
    }
  }
}

# A CI artifact in this network's .scratch folder. Missing, it stops a real run; a dry run goes on and says so.
function Get-Artifact([string]$Name) {
  $file = Join-Path $scratch $Name
  if (-not $DryRun -and -not (Test-Path $file)) {
    Write-Error "$Name is not in $scratch yet: put the CI artifact there first (scripts/mainnet/README.md)"
    exit 1
  }
  $file
}

# A contract's code hash as NEAR shows it: base58 of the wasm's sha256. open_safe names the safe's code by it, and the
# bounty contract only takes a safe whose code it knows.
function Get-CodeHash([string]$Wasm) {
  if (-not $Wasm -or -not (Test-Path $Wasm)) { return '<code hash: the wasm is not in .scratch yet>' }
  $sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash([System.IO.File]::ReadAllBytes($Wasm))
  $abc = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  $n = [System.Numerics.BigInteger]::Zero
  foreach ($b in $sha) { $n = $n * 256 + $b }
  $out = ''
  while ($n -gt 0) { $out = [string]$abc[[int]($n % 58)] + $out; $n = [System.Numerics.BigInteger]::Divide($n, 58) }
  foreach ($b in $sha) { if ($b -ne 0) { break }; $out = '1' + $out }
  $out
}

# The wasm's sha256 in lowercase hex: OutLayer's version key, and what a code change proposes.
function Get-Sha256Hex([string]$Wasm) {
  if (-not $Wasm -or -not (Test-Path $Wasm)) { return '<sha256: the wasm is not in .scratch yet>' }
  (Get-FileHash -Algorithm SHA256 $Wasm).Hash.ToLowerInvariant()
}

# Every call to near.exe. With -DryRun it prints the call and the files it reads instead, and reports success, so the
# script shows its whole sequence.
#
# On testnet a run may answer near.exe's last question itself: with $env:MASKWARS_SEND = '1' every transaction signed
# from the keychain is sent without the question. Test NEAR only. On mainnet the variable does nothing: the owner reads
# each transaction and chooses "send" by hand, always.
function Invoke-Near {
  $cli = @($args | ForEach-Object { [string]$_ })
  if (-not $DryRun) {
    if ($Network -eq 'testnet' -and $env:MASKWARS_SEND -eq '1' -and $cli[-1] -in @('sign-with-keychain', 'sign-with-legacy-keychain')) {
      $cli += 'send'
    }
    & $NearCli @cli
    return
  }
  $shown = ($cli | ForEach-Object { if ($_ -match '\s') { "'$_'" } else { $_ } }) -join ' '
  Write-Host ''
  Write-Host "near $shown" -ForegroundColor Green
  foreach ($a in $cli) {
    if ($a -match '\.(json|txt)$' -and (Test-Path $a)) {
      Write-Host "  $([System.IO.Path]::GetFileName($a)): $(Get-Content $a -Raw)"
    } elseif ($a -match '\.wasm$') {
      if (Test-Path $a) {
        Write-Host "  $([System.IO.Path]::GetFileName($a)): $((Get-Item $a).Length) bytes, sha256 $(Get-Sha256Hex $a)"
      } else {
        Write-Host "  $([System.IO.Path]::GetFileName($a)): not in $scratch yet (the CI artifact goes there before the real run)"
      }
    }
  }
  $global:LASTEXITCODE = 0
}

# Runs a node helper of these scripts on this network: NEAR_RPC and MASKWARS_NETWORK are set for it and put back after,
# so the owner's terminal keeps what it had.
function Invoke-Node {
  $saved = @{ NEAR_RPC = $env:NEAR_RPC; MASKWARS_NETWORK = $env:MASKWARS_NETWORK }
  $env:NEAR_RPC = $Net.rpc[0]
  $env:MASKWARS_NETWORK = $Network
  try { node @args } finally { foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) } }
}

# The season's program from season-args.json, as the treasury takes it: each target's code hash from its wasm in
# .scratch (the CI artifact maskwars-season-wasm, folder safes), the judge from judge-args.json. ConvertTo-Json needs
# -Depth: the program nests deeper than its default of 2.
function Get-SeasonProgram {
  $p = (Read-Input 'season-args.json').program
  $targets = @(foreach ($t in $p.targets) {
      [ordered]@{
        challenge = $t.challenge; code_hash = (Get-CodeHash (Join-Path $scratch $t.wasm)); init = $t.init
        safe_fund = (ConvertTo-Yocto $t.safe_fund); min_loot = (ConvertTo-Yocto $t.min_loot)
      }
    })
  [ordered]@{
    masks = @($p.masks); targets = $targets; prize = (ConvertTo-Yocto $p.prize); hours = $p.hours
    commit_minutes = $p.commit_minutes; reveal_minutes = $p.reveal_minutes; judge_version = (Read-Input 'judge-args.json').version
    first_minute = $p.first_minute; every_minutes = $p.every_minutes
  }
}

# The season's limits from packages/network/<network>.json, as the treasury takes them: amounts in yoctoNEAR.
function Get-SeasonLimits {
  $l = $Net.limits.season
  [ordered]@{ max_prize = (ConvertTo-Yocto $l.max_prize); max_safe_fund = (ConvertTo-Yocto $l.max_safe_fund); max_per_day = $l.max_per_day }
}
