# Tạo icon PNG cho extension (chạy: powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1)
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'icons'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function New-RoundedPath([int]$x, [int]$y, [int]$w, [int]$h, [int]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = [Math]::Max(2, $r * 2)
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

foreach ($size in 16, 32, 48, 128) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    $radius = [int][Math]::Round($size * 0.22)
    $path = New-RoundedPath 0 0 $size $size $radius
    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rect,
        [System.Drawing.Color]::FromArgb(255, 34, 197, 94),
        [System.Drawing.Color]::FromArgb(255, 13, 148, 136),
        45
    )
    $g.FillPath($brush, $path)

    $penWidth = [float][Math]::Max(1.6, $size * 0.13)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, $penWidth)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    $points = @(
        (New-Object System.Drawing.PointF([float]($size * 0.24), [float]($size * 0.52))),
        (New-Object System.Drawing.PointF([float]($size * 0.43), [float]($size * 0.72))),
        (New-Object System.Drawing.PointF([float]($size * 0.77), [float]($size * 0.30)))
    )
    $g.DrawLines($pen, $points)

    $target = Join-Path $outDir ("icon{0}.png" -f $size)
    $bmp.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)

    $pen.Dispose(); $brush.Dispose(); $path.Dispose(); $g.Dispose(); $bmp.Dispose()
    Write-Output ("created {0}" -f $target)
}
