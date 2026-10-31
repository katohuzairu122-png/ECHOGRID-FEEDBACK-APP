# Isolated GitHub-hosted runner fixtures only. Never run against the owner's workstation.
param([Parameter(Mandatory=$true)][ValidateSet('Prepare','Denial','Ancestor','Cleanup')][string]$Operation)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Disposable hosted runner required' }
$statePath = Join-Path $env:RUNNER_TEMP 'secure-file-fixture.json'
$credentialPath = Join-Path $env:RUNNER_TEMP 'secure-file-test-credential.xml'
function Diskpart([string[]]$Commands) {
  $scriptPath = Join-Path $env:RUNNER_TEMP 'secure-file-diskpart.txt'
  $Commands | Set-Content -LiteralPath $scriptPath -Encoding ascii
  try {
    & diskpart.exe /s $scriptPath
    if ($LASTEXITCODE -ne 0) { throw 'Disposable disk operation failed' }
  } finally { Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue }
}
if ($Operation -eq 'Prepare') {
  if (Test-Path -LiteralPath $statePath) { throw 'Fixture state already exists' }
  $letter = @('Z','Y','X','W') | Where-Object { !(Test-Path "${_}:\") -and !(Get-Volume -DriveLetter $_ -ErrorAction SilentlyContinue) } | Select-Object -First 1
  if (!$letter) { throw 'No unused fixture drive letter' }
  $disk = Join-Path $env:RUNNER_TEMP 'secure-file-test.vhd'
  if (Test-Path -LiteralPath $disk) { throw 'Fixture disk already exists' }
  $user = 'sf' + [Guid]::NewGuid().ToString('N').Substring(0, 14)
  @{ disk=$disk; letter=$letter; user=$user; userCreated=$false; userSid='' } | ConvertTo-Json | Set-Content $statePath
  Diskpart @("create vdisk file=`"$disk`" maximum=128 type=expandable", "select vdisk file=`"$disk`"", 'attach vdisk', 'create partition primary', 'format fs=ntfs quick label=SecureFileTest', "assign letter=$letter")
  $volume = Get-Volume -DriveLetter $letter
  if ($volume.FileSystem -ne 'NTFS' -or $volume.FileSystemLabel -ne 'SecureFileTest') { throw 'Disposable NTFS not established' }
  $root = "${letter}:\"
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetOwner($identity.User)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($identity.User.Value, 'S-1-5-18', 'S-1-5-32-544')) {
    $principal = [System.Security.Principal.SecurityIdentifier]::new($sid)
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  }
  # Read/traverse only. No mutation rights are granted to the adversarial account.
  $users = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($users, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  Set-Acl -LiteralPath $root -AclObject $acl
  $testRoot = Join-Path $root 'tests'
  New-Item -ItemType Directory -Path $testRoot | Out-Null
  "SF_WINDOWS_TEST_ROOT=$testRoot" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
  $password = ConvertTo-SecureString ('Sf!9' + [Guid]::NewGuid().ToString('N') + 'aZ') -AsPlainText -Force
  $createdUser = New-LocalUser -Name $user -Password $password -AccountNeverExpires
  $state = Get-Content $statePath -Raw | ConvertFrom-Json
  $state.userCreated = $true
  $state.userSid = $createdUser.SID.Value
  $state | ConvertTo-Json | Set-Content $statePath
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $user
  [PSCredential]::new("$env:COMPUTERNAME\$user", $password) | Export-Clixml -LiteralPath $credentialPath
  git rev-parse HEAD
  node --version
  $volume | Select-Object DriveLetter, FileSystem, FileSystemLabel
  return
}
if (!(Test-Path -LiteralPath $statePath)) {
  if ($Operation -eq 'Cleanup') { return }
  throw 'Fixture state absent'
}
$state = Get-Content $statePath -Raw | ConvertFrom-Json
$expectedDisk = Join-Path $env:RUNNER_TEMP 'secure-file-test.vhd'
if ($state.disk -ne $expectedDisk -or $state.user -notmatch '^sf[0-9a-f]{14}$' -or $state.letter -notmatch '^[WXYZ]$') { throw 'Untrusted fixture state; refusing resource operations' }
if ($Operation -eq 'Ancestor') {
  # R9: real distinct-account ancestor cases on the disposable NTFS volume. The account is the one created by Prepare and removed by Cleanup; no real data,
  # no production credential. Each case is a directory tree whose ancestors are owned by, writable by, or merely readable by that account.
  $letter = $state.letter
  $base = Join-Path "${letter}:\" 'ancestor-cases'
  New-Item -ItemType Directory -Path $base | Out-Null
  $accountSid = (Get-LocalUser -Name $state.user).SID.Value
  if ($accountSid -ne $state.userSid) { throw 'Account identity changed; refusing ancestor fixtures' }
  function New-Case([string]$name, [string[]]$icaclsArgs) {
    $dir = Join-Path $base $name
    New-Item -ItemType Directory -Path (Join-Path $dir 'inner') -Force | Out-Null
    if ($icaclsArgs.Count -gt 0) {
      & icacls.exe $dir @icaclsArgs | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "Ancestor fixture '$name' could not be configured" }
    }
  }
  New-Case 'private' @()
  New-Case 'owned-by-account' @('/setowner', "*$accountSid")
  New-Case 'account-modify' @('/grant', "*${accountSid}:(OI)(CI)(M)")
  New-Case 'account-delete-child' @('/grant', "*${accountSid}:(DC)")
  New-Case 'account-read-only' @('/grant', "*${accountSid}:(OI)(CI)(RX)")
  $env:SF_ANCESTOR_CASES = $base
  $env:SF_ACCOUNT_SID = $accountSid
  # Absolute paths and no change of the working directory: the workflow pipes this script into Tee-Object with a repo-relative path, which would resolve
  # against a changed location. node resolves the test's own imports relative to the test file.
  $packageDir = (Resolve-Path 'packages/secure-file').Path
  $evidenceDir = Join-Path $packageDir 'evidence'
  New-Item -ItemType Directory -Force $evidenceDir | Out-Null
  $testFile = Join-Path $packageDir 'test/secure-file.win32-accounts.test.js'
  node --expose-gc --test --test-reporter=tap $testFile 2>&1 | Tee-Object (Join-Path $evidenceDir 'windows-ancestors.tap')
  if ($LASTEXITCODE -ne 0) { throw 'Distinct-account ancestor tests failed' }
  return
}
if ($Operation -eq 'Denial') {
  $dir = Join-Path "$($state.letter):\" 'denial'
  New-Item -ItemType Directory -Path $dir | Out-Null
  $secret = Join-Path $dir 'synthetic-secret'
  $canary = Join-Path $dir 'public-canary'
  [IO.File]::WriteAllText($canary, 'SF_PUBLIC')
  $module = (Resolve-Path 'packages/secure-file/index.js').Path
  node --input-type=module -e 'import {pathToFileURL} from "node:url"; const {writeSecretFileExclusive}=await import(pathToFileURL(process.argv[1])); writeSecretFileExclusive(process.argv[2], Buffer.from("SF_TEST_SYNTHETIC"));' $module $secret
  if ($LASTEXITCODE -ne 0) { throw 'Synthetic fixture creation failed' }
  # Use Windows PowerShell because the independent-user harness uses its credentialed process API.
  $harness = (Resolve-Path 'packages/secure-file/test/ci/windows-denial-runner.ps1').Path
  & powershell.exe -NoProfile -File $harness -SecretPath $secret -PublicCanary $canary -CredentialPath $credentialPath
  if ($LASTEXITCODE -ne 0) { throw 'Independent-user denial failed' }
  return
}
# Cleanup is limited to the recorded disposable account and virtual disk.
try {
  $existingUser = Get-LocalUser -Name $state.user -ErrorAction SilentlyContinue
  if ($state.userCreated -and $existingUser) {
    if (!$state.userSid -or $existingUser.SID.Value -ne $state.userSid) { throw 'Account identity changed; refusing removal' }
    Remove-LocalUser -Name $state.user
  }
} finally {
  Remove-Item -LiteralPath $credentialPath -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $state.disk) {
    Diskpart @("select vdisk file=`"$($state.disk)`"", 'detach vdisk')
    Remove-Item -LiteralPath $state.disk -Force
  }
  Remove-Item -LiteralPath $statePath -Force
}
