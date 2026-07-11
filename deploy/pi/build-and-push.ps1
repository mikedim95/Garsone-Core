param(
  [Parameter(Mandatory = $true)]
  [string]$Namespace,

  [string]$Tag = "pi",
  [string]$Platform = "linux/arm64",
  [string]$CoreContext = "",
  [string]$FrontContext = "",
  [switch]$AlsoLatest
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker CLI was not found."
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $CoreContext) {
  $CoreContext = Resolve-Path (Join-Path $scriptDir "..\..")
}
if (-not $FrontContext) {
  $FrontContext = Resolve-Path (Join-Path $scriptDir "..\..\..\Garsone-Front")
}

$coreImage = "$Namespace/garsone-core:$Tag"
$frontImage = "$Namespace/garsone-front:$Tag"

docker buildx inspect garsone-pi-builder *> $null
if ($LASTEXITCODE -ne 0) {
  docker buildx create --name garsone-pi-builder --use | Out-Host
} else {
  docker buildx use garsone-pi-builder
}

$coreTags = @("-t", $coreImage)
$frontTags = @("-t", $frontImage)
if ($AlsoLatest) {
  $coreTags += @("-t", "$Namespace/garsone-core:latest")
  $frontTags += @("-t", "$Namespace/garsone-front:latest")
}

Write-Host "Building and pushing $coreImage for $Platform"
docker buildx build --platform $Platform --pull --push @coreTags $CoreContext

Write-Host "Building and pushing $frontImage for $Platform"
docker buildx build --platform $Platform --pull --push @frontTags $FrontContext

Write-Host "Pushed:"
Write-Host "  $coreImage"
Write-Host "  $frontImage"
