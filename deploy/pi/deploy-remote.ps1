param(
  [Parameter(Mandatory = $true)]
  [Alias("HostName")]
  [string]$PiHost,

  [string]$User = "piadmin",
  [string]$PublicHost = "",
  [string]$InstallUrl = "https://raw.githubusercontent.com/mikedim95/Garsone-Core/stage/deploy/pi/install.sh",
  [string]$AppDir = "",
  [switch]$NoSeed
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
  throw "OpenSSH client was not found."
}

$argsList = @()
if ($PublicHost) {
  $argsList += @("--host", $PublicHost)
} else {
  $argsList += @("--host", $PiHost)
}
if ($AppDir) {
  $argsList += @("--dir", $AppDir)
}
if ($NoSeed) {
  $argsList += "--no-seed"
}

$quotedArgs = ($argsList | ForEach-Object { "'" + ($_ -replace "'", "'\''") + "'" }) -join " "
$remoteCommand = "curl -fsSL '$InstallUrl' | bash -s -- $quotedArgs"

Write-Host "Deploying Garsone to $User@$PiHost"
ssh -tt "$User@$PiHost" $remoteCommand
