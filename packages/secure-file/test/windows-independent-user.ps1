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
# CreateProcessWithLogonW (behind credentialed Start-Process/ProcessStartInfo) rejects command lines over 1024 characters with ERROR_INVALID_PARAMETER
# ("The parameter is incorrect"), so the child script is NOT passed as -EncodedCommand. It is written next to the fixtures (the disposable account has
# read/execute there and no write access) and launched with a short -File command line. Output comes back over pipes, so no file in a location the
# account cannot write is needed, and the working directory is one the account can enter.
$fixtureDir = [IO.Path]::GetDirectoryName((Resolve-Path -LiteralPath $SecretPath).Path)
$childPath = Join-Path $fixtureDir ('child-' + [Guid]::NewGuid().ToString('N') + '.ps1')
[IO.File]::WriteAllText($childPath, $child, [Text.UTF8Encoding]::new($true))
$exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $childPath + '"'
if (($exe.Length + $arguments.Length + 4) -ge 1000) { throw 'Credentialed command line would exceed the CreateProcessWithLogonW limit' }
$net = $OtherCredential.GetNetworkCredential()
$psi = [System.Diagnostics.ProcessStartInfo]::new($exe, $arguments)
$psi.UseShellExecute = $false
$psi.UserName = $net.UserName
$psi.Domain = $net.Domain
$psi.Password = $OtherCredential.Password
$psi.LoadUserProfile = $true
$psi.WorkingDirectory = $fixtureDir
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
try {
  $proc = [System.Diagnostics.Process]::Start($psi)
  $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
  $stderrTask = $proc.StandardError.ReadToEndAsync()
  if (!$proc.WaitForExit(90000)) { try { $proc.Kill() } catch { }; throw 'Independent-user process timed out; no denial result established' }
  $null = [System.Threading.Tasks.Task]::WaitAll(@($stdoutTask, $stderrTask), 10000)
  $stdout = $stdoutTask.Result
  if ($proc.ExitCode -ne 0) {
    $detail = ($stderrTask.Result -replace '\s+', ' ')
    if ($detail.Length -gt 400) { $detail = $detail.Substring(0, 400) }
    throw "Independent-user process failed (exit $($proc.ExitCode)); no denial result established: $detail"
  }
  $result = $stdout | ConvertFrom-Json
  if (!$result.sid -or $result.sid -eq $ownerSid) { throw 'Distinct identity not established' }
  if ($result.administrator -ne $false -or $result.sid -in @('S-1-5-18', 'S-1-5-19', 'S-1-5-20')) { throw 'Unprivileged child token not established' }
  # Liveness first: the account must demonstrably reach the directory and read the public canary before any denial result is believed.
  if ($result.canary -ne 'SF_PUBLIC') { throw 'Independent-user liveness failed' }
  foreach ($operation in @('read', 'append', 'delete', 'rename')) {
    if ($result.$operation -ne 'System.UnauthorizedAccessException') { throw "Expected access denial: $operation (got $($result.$operation))" }
  }
  if ([IO.File]::ReadAllText($SecretPath) -ne 'SF_TEST_SYNTHETIC') { throw 'Fixture was modified' }
  if (!(Test-Path -LiteralPath $SecretPath)) { throw 'Fixture was removed or renamed' }
  Write-Output "PASS: distinct SID $($result.sid), liveness, read/append/delete/rename denial, unchanged synthetic fixture"
} finally {
  Remove-Item -LiteralPath $childPath -Force -ErrorAction SilentlyContinue
}
