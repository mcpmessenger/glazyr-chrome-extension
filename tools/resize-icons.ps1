param(
  [string]$Source = "dist/Mechanical eye with blue iris.png",
  [string]$OutDir = "dist/icons"
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

if (-not (Test-Path -LiteralPath $Source)) {
  # fallback to repo root (common when the logo source is kept outside dist/)
  $fallback = "Mechanical eye with blue iris.png"
  if (Test-Path -LiteralPath $fallback) {
    $Source = $fallback
  } else {
    throw "Source image not found: $Source (also tried: $fallback)"
  }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$sizes = @(16, 48, 128)

foreach ($size in $sizes) {
  $outPath = Join-Path $OutDir ("icon{0}.png" -f $size)

  $img = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $Source))
  try {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    try {
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      try {
        $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

        $g.Clear([System.Drawing.Color]::Transparent)
        $g.DrawImage($img, 0, 0, $size, $size)
      }
      finally {
        $g.Dispose()
      }

      $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
      $bmp.Dispose()
    }
  }
  finally {
    $img.Dispose()
  }
}

# Verify output sizes
foreach ($p in @(
  "dist/icons/icon16.png",
  "dist/icons/icon48.png",
  "dist/icons/icon128.png"
)) {
  $i = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $p))
  try {
    Write-Host "$p -> $($i.Width)x$($i.Height)"
  }
  finally {
    $i.Dispose()
  }
}


