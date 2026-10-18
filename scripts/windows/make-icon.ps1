# Regenerates scripts/windows/lumendock.ico and scripts/linux/lumendock{,-48}.png from the dashboard favicon's geometry
# (dashboard/public/favicon.svg: dark rounded square, cyan diamond outline, filled inner diamond).
# The .ico holds PNG frames at the sizes Windows asks for on the desktop, taskbar and tray.
param([string]$Out = (Join-Path $PSScriptRoot 'lumendock.ico'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function New-Frame([int]$size, [switch]$Png) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $s = $size / 48.0
  $bg = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = 10 * $s * 2
  $bg.AddArc(0, 0, $r, $r, 180, 90); $bg.AddArc($size - $r, 0, $r, $r, 270, 90)
  $bg.AddArc($size - $r, $size - $r, $r, $r, 0, 90); $bg.AddArc(0, $size - $r, $r, $r, 90, 90); $bg.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#111719'))), $bg)
  $cyan = [System.Drawing.ColorTranslator]::FromHtml('#79d5dc')
  $pt = { param($x, $y) New-Object System.Drawing.PointF(($x * $s), ($y * $s)) }
  $outer = @((& $pt 24 7), (& $pt 41 24), (& $pt 24 41), (& $pt 7 24))
  $g.DrawPolygon((New-Object System.Drawing.Pen($cyan, [Math]::Max(1.0, 2 * $s))), $outer)
  $inner = @((& $pt 24 15), (& $pt 33 24), (& $pt 24 33), (& $pt 15 24))
  $g.FillPolygon((New-Object System.Drawing.SolidBrush($cyan)), $inner)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  if ($size -ge 256 -or $Png) {
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  } else {
    # Small frames as classic 32-bit DIBs: .NET's Icon (used by the tray) cannot decode PNG frames.
    $bw = New-Object System.IO.BinaryWriter($ms)
    $bw.Write([UInt32]40); $bw.Write([Int32]$size); $bw.Write([Int32]($size * 2)); $bw.Write([UInt16]1); $bw.Write([UInt16]32)
    $bw.Write([UInt32]0); $bw.Write([UInt32]0); $bw.Write([Int32]0); $bw.Write([Int32]0); $bw.Write([UInt32]0); $bw.Write([UInt32]0)
    for ($y = $size - 1; $y -ge 0; $y--) {
      for ($x = 0; $x -lt $size; $x++) { $c = $bmp.GetPixel($x, $y); $bw.Write([byte]$c.B); $bw.Write([byte]$c.G); $bw.Write([byte]$c.R); $bw.Write([byte]$c.A) }
    }
    $maskRow = [int]([Math]::Ceiling($size / 32.0) * 4)
    $bw.Write((New-Object byte[] ($maskRow * $size)))
    $bw.Flush()
  }
  $bmp.Dispose()
  , $ms.ToArray()
}

$sizes = 16, 20, 24, 32, 40, 48, 64, 256
$frames = foreach ($size in $sizes) { , (New-Frame $size) }
$file = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter($file)
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $dim = $(if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] })
  $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]$frames[$i].Length); $w.Write([UInt32]$offset)
  $offset += $frames[$i].Length
}
foreach ($frame in $frames) { $w.Write($frame) }
$w.Flush()
[System.IO.File]::WriteAllBytes($Out, $file.ToArray())
"Wrote $Out"

# The same artwork as PNGs for the Linux launcher (256) and tray (48).
$linux = Join-Path (Split-Path $PSScriptRoot -Parent) 'linux'
New-Item -ItemType Directory -Force $linux | Out-Null
foreach ($pair in @(@(256, 'lumendock.png'), @(48, 'lumendock-48.png'))) {
  $path = Join-Path $linux $pair[1]
  [System.IO.File]::WriteAllBytes($path, (New-Frame $pair[0] -Png))
  "Wrote $path"
}
