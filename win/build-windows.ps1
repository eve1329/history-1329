param(
  [string]$Runtime = "win-x64",
  [string]$Configuration = "Release",
  [string]$NodeVersion = "24.13.0",
  [string]$NodeZip = "",
  [switch]$SkipNodeDownload
)

$ErrorActionPreference = "Stop"

$AppName = "Codex History Viewer"
$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$DistRoot = Join-Path $RootDir "dist\win"
$PackageDir = Join-Path $DistRoot $AppName
$ViewerDir = Join-Path $PackageDir "viewer"
$NodeDir = Join-Path $PackageDir "node"
$CacheDir = Join-Path $RootDir ".cache\windows"

function Copy-DirectoryContents {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Copy-Item -Path (Join-Path $Source "*") -Destination $Destination -Recurse -Force
}

function Resolve-NodeArchiveName {
  param([string]$Runtime)

  switch ($Runtime) {
    "win-x64" { return "node-v$NodeVersion-win-x64" }
    "win-arm64" { return "node-v$NodeVersion-win-arm64" }
    default {
      throw "Unsupported runtime '$Runtime'. Use win-x64 or win-arm64."
    }
  }
}

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
  throw "dotnet was not found. Install .NET 8 SDK on Windows, then rerun this script."
}

$nodeArchiveName = Resolve-NodeArchiveName -Runtime $Runtime
$resolvedNodeZip = $NodeZip

if ([string]::IsNullOrWhiteSpace($resolvedNodeZip)) {
  $resolvedNodeZip = Join-Path $CacheDir "$nodeArchiveName.zip"
}

if (-not (Test-Path $resolvedNodeZip)) {
  if ($SkipNodeDownload) {
    throw "Node zip not found at '$resolvedNodeZip'. Remove -SkipNodeDownload or pass -NodeZip C:\path\to\$nodeArchiveName.zip."
  }

  New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
  $nodeUrl = "https://nodejs.org/dist/v$NodeVersion/$nodeArchiveName.zip"
  Write-Host "Downloading $nodeUrl"
  Invoke-WebRequest -Uri $nodeUrl -OutFile $resolvedNodeZip
}

if (Test-Path $PackageDir) {
  Remove-Item $PackageDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $PackageDir, $ViewerDir, $NodeDir | Out-Null

Write-Host "Publishing Windows launcher..."
dotnet publish (Join-Path $PSScriptRoot "CodexHistoryViewer.csproj") `
  -c $Configuration `
  -r $Runtime `
  --self-contained true `
  -p:PublishSingleFile=true `
  -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:EnableCompressionInSingleFile=true `
  -p:DebugType=None `
  -p:DebugSymbols=false `
  -o $PackageDir

Write-Host "Copying viewer files..."
Copy-Item (Join-Path $RootDir "package.json") (Join-Path $ViewerDir "package.json") -Force
Copy-Item (Join-Path $RootDir "server.mjs") (Join-Path $ViewerDir "server.mjs") -Force
Copy-DirectoryContents -Source (Join-Path $RootDir "public") -Destination (Join-Path $ViewerDir "public")
$licenseConfig = Join-Path $RootDir "license.json"
if (Test-Path $licenseConfig) {
  Copy-Item $licenseConfig (Join-Path $ViewerDir "license.json") -Force
}

$nodeExtractRoot = Join-Path $CacheDir $nodeArchiveName
if (Test-Path $nodeExtractRoot) {
  Remove-Item $nodeExtractRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $nodeExtractRoot | Out-Null

Write-Host "Extracting bundled Node..."
Expand-Archive -Path $resolvedNodeZip -DestinationPath $nodeExtractRoot -Force
$nodeSourceDir = Join-Path $nodeExtractRoot $nodeArchiveName
if (-not (Test-Path (Join-Path $nodeSourceDir "node.exe"))) {
  throw "Extracted Node archive does not contain node.exe at expected path: $nodeSourceDir"
}

Copy-Item (Join-Path $nodeSourceDir "node.exe") (Join-Path $NodeDir "node.exe") -Force
foreach ($fileName in @("LICENSE", "README.md")) {
  $candidate = Join-Path $nodeSourceDir $fileName
  if (Test-Path $candidate) {
    Copy-Item $candidate (Join-Path $NodeDir $fileName) -Force
  }
}

$readmePath = Join-Path $PackageDir "README-Windows.txt"
@"
Codex History Viewer for Windows
================================

Run:
  CodexHistoryViewer.exe

What this package contains:
  - CodexHistoryViewer.exe: small Windows launcher.
  - node\node.exe: bundled Node.js $NodeVersion for node:sqlite support.
  - viewer\server.mjs and viewer\public: the local Codex History Viewer web app.

Runtime behavior:
  - Uses CODEX_HOME if set; otherwise reads %USERPROFILE%\.codex.
  - Starts a local HTTP server on 127.0.0.1 using an available port.
  - Opens the default browser automatically.
  - Keeps running in the Windows notification area until Exit is selected.
  - Writes logs to %LOCALAPPDATA%\CodexHistoryViewer\codex-history-viewer.log.

Optional environment variables:
  - CODEX_HOME: override the Codex home directory.
  - CODEX_HISTORY_DB: override the state_5.sqlite path.
  - CODEX_HISTORY_VIEWER_PORT: force a port instead of auto-selecting one.
  - CODEX_HISTORY_VIEWER_NODE: use a specific node.exe instead of bundled Node.

Provider Sync backups are written under:
  %CODEX_HOME%\backups_state\provider-sync

Notes:
  - This package is $Runtime. Build win-arm64 separately for native Windows on ARM.
  - If Windows Defender SmartScreen appears, it is because this local build is not signed.
"@ | Set-Content -Path $readmePath -Encoding UTF8

Write-Host "Built $PackageDir"
