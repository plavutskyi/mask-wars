# Puts the jobs and crews contracts (contracts/jobs, contracts/crews) on their own accounts, $Jobs and $Crews
# (jobs.maskwars.near and crews.maskwars.near on mainnet), each in one transaction signed by $Admin that creates the
# account, funds it (fund.jobs and fund.crews of packages/network: about 5.7 and 2.8 NEAR pay for the code), deploys the
# code and calls new(...). Neither transaction adds a key: nobody, the owner included, deploys to them or moves their
# NEAR by hand (contracts/jobs/README.md, "Who can change what").
#
# jobs new(...) gets: $Admin as admin, meter (books what each mask's mind burned) and treasury (the fuel of a counted
# step is paid to it, and it pays the masks' inference on NEAR AI Cloud); this network's OutLayer; $Crews; the judges in
# jobs-args.json (none until the judges are published with their TEE keys: then jobs-change.ps1 -Judge, an hour each);
# the bounty contract and, once it is on chain, the mask factory of this network; the fee and $Admin as the account it
# goes to. crews new(...) gets $Admin and the same factories. The judges of jobs answer only the jobs
# contract written into their wasm: `jobs.tinygif8324.testnet`, and on mainnet `jobs.maskwars.near` only in a build made
# with --mainnet after maskwars.near is registered (scripts/mainnet/README.md). The wasm files are the CI artifact
# `maskwars-jobs-wasm` (or contracts/jobs/build.sh, the same bytes) in .scratch. The owner chooses "send" twice.
#   .\jobs-deploy.ps1 -Network mainnet -DryRun
param([string]$Network, [switch]$DryRun)
. (Join-Path $PSScriptRoot 'config.ps1')
$jobsWasm = Get-Artifact 'maskwars_jobs.wasm'
$crewsWasm = Get-Artifact 'maskwars_crews.wasm'
$a = Read-Input 'jobs-args.json'
if ($a.fee_bps -gt 1000) { Write-Error 'jobs-args.json: the fee is at most 1000 basis points, 10%'; exit 1 }
$jobsInit = Get-ScratchFile 'jobs-init-args.json'
$crewsInit = Get-ScratchFile 'crews-init-args.json'
# The mask factory only once it is on chain (sections.forge): before that no job may be open to forged masks nobody has.
# Then the admin proposes {"kind":"factories"} on both contracts, which applies after an hour (scripts/mainnet/jobs.mjs).
$factories = @()
if ($Net.sections.forge) { $factories = @($Factory) }
[ordered]@{
  admin = $Admin; meter = $Admin; treasury = $Admin; outlayer = $Outlayer; crews = $Crews; judges = @($a.judges)
  bounties = @($Bounty); factories = $factories; fee_bps = $a.fee_bps; fee_to = $Admin
} | ConvertTo-Json -Compress -Depth 5 | Set-Content -Encoding ascii $jobsInit
[ordered]@{ admin = $Admin; factories = $factories } | ConvertTo-Json -Compress | Set-Content -Encoding ascii $crewsInit
if (@($a.judges).Count -eq 0) { Write-Host 'jobs-args.json names no judge: no tee_tests or ai_review job opens until jobs-change.ps1 -Judge.' }
Write-Host "jobs code sha256 $(Get-Sha256Hex $jobsWasm), crews code sha256 $(Get-Sha256Hex $crewsWasm)"
Invoke-Near transaction construct-transaction $Admin $Jobs add-action create-account add-action transfer "$($Net.fund.jobs) NEAR" add-action deploy-contract use-file $jobsWasm with-init-call new file-args $jobsInit prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' skip network-config $Network sign-with-keychain
Invoke-Near transaction construct-transaction $Admin $Crews add-action create-account add-action transfer "$($Net.fund.crews) NEAR" add-action deploy-contract use-file $crewsWasm with-init-call new file-args $crewsInit prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' skip network-config $Network sign-with-keychain
Remove-Item $jobsInit, $crewsInit
Remove-Scratch
