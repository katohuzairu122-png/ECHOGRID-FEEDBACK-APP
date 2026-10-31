# Run only with disposable synthetic fixtures created by the tested module.
# A distinct existing unprivileged account is required; passwords never enter command-line arguments.
param(
  [Parameter(Mandatory=$true)][string]$SecretPath,
  [Parameter(Mandatory=$true)][string]$PublicCanary,
  [Parameter(Mandatory=$true)][System.Management.Automation.PSCredential]$OtherCredential
)
$ErrorActionPreference = 'Stop'
$ownerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ([IO.File]::ReadAllText($SecretPath) -ne 'SF_TEST_SYNTHETIC') { throw 'Synthetic secret fixture required' }
if ([IO.File]::ReadAllText($PublicCanary) -ne 'SF_PUBLIC') { throw 'Public liveness fixture required' }
if ([IO.Path]::GetDirectoryName((Resolve-Path -LiteralPath $SecretPath).Path) -ne [IO.Path]::GetDirectoryName((Resolve-Path -LiteralPath $PublicCanary).Path)) { throw 'Canary must share the secret parent directory to prove traversal' }
$payload = @{ secret = (Resolve-Path -LiteralPath $SecretPath).Path; canary = (Resolve-Path -LiteralPath $PublicCanary).Path } | ConvertTo-Json -Compress
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
$child = @'
$ErrorActionPreference = 'Stop'
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('PAYLOAD')) | ConvertFrom-Json
$result = @{ sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
$principal = [System.Security.Principal.WindowsPrincipal]::new([System.Security.Principal.WindowsIdentity]::GetCurrent())
$result.administrator = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
$result.canary = [IO.File]::ReadAllText($p.canary)
foreach ($operation in @('read', 'append', 'delete', 'rename')) {
  try {
    switch ($operation) {
      'read' { $null = [IO.File]::ReadAllBytes($p.secret) }
      'append' { [IO.File]::AppendAllText($p.secret, 'X') }
      'delete' { [IO.File]::Delete($p.secret) }
      'rename' { [IO.File]::Move($p.secret, $p.secret + '.moved') }
    }
    $result[$operation] = 'ALLOWED'
  } catch {
    $e = $_.Exception
    while ($e.InnerException) { $e = $e.InnerException }
    $result[$operation] = $e.GetType().FullName
  }
}
$result | ConvertTo-Json -Compress
'@
$child = $child.Replace('PAYLOAD', $encoded)
$command = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($child))
$out = [IO.Path]::GetTempFileName()
$err = [IO.Path]::GetTempFileName()
try {
  $proc = Start-Process -FilePath "$PSHOME\powershell.exe" -Credential $OtherCredential -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $command) -Wait -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  if ($proc.ExitCode -ne 0) { throw 'Independent-user process failed; no denial result established' }
  $result = Get-Content -LiteralPath $out -Raw | ConvertFrom-Json
  if (!$result.sid -or $result.sid -eq $ownerSid) { throw 'Distinct identity not established' }
  if ($result.administrator -ne $false -or $result.sid -in @('S-1-5-18', 'S-1-5-19', 'S-1-5-20')) { throw 'Unprivileged child token not established' }
  if ($result.canary -ne 'SF_PUBLIC') { throw 'Independent-user liveness failed' }
  foreach ($operation in @('read', 'append', 'delete', 'rename')) {
    if ($result.$operation -ne 'System.UnauthorizedAccessException') { throw "Expected access denial: $operation" }
  }
  if ([IO.File]::ReadAllText($SecretPath) -ne 'SF_TEST_SYNTHETIC') { throw 'Fixture was modified' }
  Write-Output 'PASS: distinct SID, liveness, read/append/delete/rename denial, unchanged synthetic fixture'
} finally {
  Remove-Item -LiteralPath $out, $err -Force
}
