<#
    pack.ps1 — stamp a version across the project, then package dist\FrameFlow-<version>.zip

        .\pack.ps1 1.1.0
        .\pack.ps1 -Version 1.1.0
        .\pack.ps1 1.1.0 -StageOnly     # package it, but don't touch the source files

    The version lives in five hardcoded spots (CEP manifest x2, the ExtendScript
    host, and two places in the panel UI). Editing them by hand is how a build ends
    up reporting one version in the Extensions menu and another in the panel, so
    this script is the single source of truth: pass the version once.

    By default the source files are rewritten in place, so the repo and the zip
    always agree. Use -StageOnly to leave the working tree alone (handy for a
    throwaway build), but be aware the panel will then still show the old version.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidatePattern('^\d+\.\d+(\.\d+){0,2}$')]
    [string] $Version,

    # Package without rewriting the source files.
    [switch] $StageOnly
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$dist = Join-Path $root "dist"

# CEP shows the full x.y.z; the panel chrome shows the short "v1.1" form.
$parts   = $Version.Split('.')
$display = if ($parts.Count -ge 2) { "$($parts[0]).$($parts[1])" } else { $Version }

# Write UTF-8 *without* a BOM. Set-Content/Out-File in PS 5.1 would prepend one,
# which breaks the XML declaration in manifest.xml and litters index.html.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-Text([string] $Path, [string] $Text) {
    [System.IO.File]::WriteAllText($Path, $Text, $utf8NoBom)
}

# Apply regex replacements to a file. Each rule is @{ Find = '<regex>'; Replace = '<subst>' }.
# Errors out if any rule matches nothing — a silently-skipped stamp is the exact
# failure mode this script exists to prevent.
function Set-Version([string] $Path, [array] $Rules) {
    if (-not (Test-Path $Path)) { throw "Missing file: $Path" }
    $text = [System.IO.File]::ReadAllText($Path)
    foreach ($rule in $Rules) {
        if ($text -notmatch $rule.Find) {
            throw "Version pattern not found in $(Split-Path $Path -Leaf): $($rule.Find)"
        }
        $text = [regex]::Replace($text, $rule.Find, $rule.Replace)
    }
    Write-Text $Path $text
    Write-Host "  stamped $(Split-Path $Path -Leaf)" -ForegroundColor DarkGray
}

Write-Host "Packaging FrameFlow $Version..." -ForegroundColor Cyan

# ---- 1. stamp -----------------------------------------------------------------
$targets = @(
    @{
        Path  = Join-Path $root "CSXS\manifest.xml"
        Rules = @(
            @{ Find = '(ExtensionBundleVersion=")[^"]*(")';            Replace = "`${1}$Version`${2}" },
            @{ Find = '(<Extension\s+Id="[^"]+"\s+Version=")[^"]*(")'; Replace = "`${1}$Version`${2}" }
        )
    },
    @{
        Path  = Join-Path $root "host\FrameFlow.jsx"
        Rules = @(
            @{ Find = '(var VERSION = ")[^"]*(")'; Replace = "`${1}$Version`${2}" }
        )
    },
    @{
        Path  = Join-Path $root "client\index.html"
        Rules = @(
            # <span class="ver" title="Version 1.0">v1.0</span>
            @{ Find = '(<span class="ver" title="Version )[^"]*(">v)[^<]*(</span>)'; Replace = "`${1}$display`${2}$display`${3}" },
            # <div class="credit">FrameFlow v1.0 — crafted by ...
            @{ Find = '(FrameFlow v)[\d.]+';                                          Replace = "`${1}$display" }
        )
    }
)

if ($StageOnly) {
    Write-Host "  -StageOnly: source files left untouched" -ForegroundColor Yellow
} else {
    foreach ($t in $targets) { Set-Version $t.Path $t.Rules }
}

# ---- 2. stage -----------------------------------------------------------------
# Stage under a 'FrameFlow' folder so the zip unpacks to a named directory rather
# than spraying files into the recipient's Downloads.
$stage = Join-Path ([System.IO.Path]::GetTempPath()) "FrameFlow-pack-$Version"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
$payload = Join-Path $stage "FrameFlow"
New-Item -ItemType Directory -Path $payload -Force | Out-Null

$required = @("CSXS", "client", "host")
$optional = @(".debug", "install-windows.ps1", "install-mac.command", "README.md")

foreach ($item in $required) {
    $src = Join-Path $root $item
    if (-not (Test-Path $src)) { throw "Required item missing from project: $item" }
    Copy-Item $src $payload -Recurse -Force
}
foreach ($item in $optional) {
    $src = Join-Path $root $item
    if (Test-Path $src) { Copy-Item $src $payload -Recurse -Force }
    else { Write-Host "  note: skipping absent $item" -ForegroundColor DarkGray }
}

# If -StageOnly, the staged copy still needs the right version or the zip lies.
if ($StageOnly) {
    foreach ($t in $targets) {
        $rel = $t.Path.Substring($root.Length).TrimStart('\')
        Set-Version (Join-Path $payload $rel) $t.Rules
    }
}

# ---- 3. zip -------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$zip = Join-Path $dist "FrameFlow-$Version.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $payload -DestinationPath $zip
Remove-Item $stage -Recurse -Force

# ---- 4. verify ----------------------------------------------------------------
# Read the version back out of the archive. A build that reports success while
# shipping a stale host script is worse than one that fails loudly.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
    $entry = $archive.Entries | Where-Object { $_.FullName -like "*host/FrameFlow.jsx" -or $_.FullName -like "*host\FrameFlow.jsx" }
    if (-not $entry) { throw "Archive is missing host/FrameFlow.jsx" }
    $reader = New-Object System.IO.StreamReader($entry.Open())
    $hostText = $reader.ReadToEnd()
    $reader.Close()
    if ($hostText -notmatch [regex]::Escape("var VERSION = `"$Version`"")) {
        throw "Archived host reports the wrong version - expected $Version"
    }
    $count = $archive.Entries.Count
} finally {
    $archive.Dispose()
}

$sizeKb = "{0:N1}" -f ((Get-Item $zip).Length / 1KB)
Write-Host "[ok] Built: $zip" -ForegroundColor Green
Write-Host "     $count files, $sizeKb KB, host reports v$Version"
Write-Host "Share this file. The recipient unzips it and runs the installer inside."
