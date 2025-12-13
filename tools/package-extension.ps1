param(
  [string]$DistDir = "dist",
  [string]$OutDir = "release"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $DistDir)) {
  throw "Dist folder not found: $DistDir"
}

$manifestPath = Join-Path $DistDir "manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "manifest.json not found at: $manifestPath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$version = $manifest.version
if ([string]::IsNullOrWhiteSpace($version)) {
  throw "manifest.json has no version"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$zipName = "glazyr-chrome-extension-v$version.zip"
$zipPath = Join-Path $OutDir $zipName

if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

# Put dist/ contents at zip root (Chrome expects manifest at zip root)
Compress-Archive -Path (Join-Path $DistDir "*") -DestinationPath $zipPath -Force

Write-Host "Created: $zipPath"


