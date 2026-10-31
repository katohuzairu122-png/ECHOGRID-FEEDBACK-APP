param(
  [Parameter(Mandatory=$true)][string]$SecretPath,
  [Parameter(Mandatory=$true)][string]$PublicCanary,
  [Parameter(Mandatory=$true)][string]$CredentialPath
)
$ErrorActionPreference = 'Stop'
$credential = Import-Clixml -LiteralPath $CredentialPath
& (Join-Path $PSScriptRoot '../windows-independent-user.ps1') -SecretPath $SecretPath -PublicCanary $PublicCanary -OtherCredential $credential
