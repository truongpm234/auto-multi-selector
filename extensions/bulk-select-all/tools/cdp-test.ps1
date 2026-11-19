# End-to-end test: load the extension into real Chrome via CDP, click the panel button, read checkbox state.
param(
    [string]$ExtensionPath = (Split-Path -Parent $PSScriptRoot),
    [int]$Port = 8765,
    [int]$DebugPort = 9333,
    [switch]$Headed,
    [ValidateSet('chrome', 'edge')]
    [string]$Browser = 'edge'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http | Out-Null

if ($Browser -eq 'edge') {
    $chrome = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
} else {
    $chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
}

$profileDir = Join-Path $env:TEMP ('bsa-cdp-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$url = "http://127.0.0.1:$Port/tools/plain.html"

$srv = Start-Process py -ArgumentList '-m', 'http.server', "$Port", '--bind', '127.0.0.1', '--directory', $ExtensionPath -PassThru -WindowStyle Hidden

$chromeArgs = @(
    "--remote-debugging-port=$DebugPort",
    "--user-data-dir=$profileDir",
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    "--disable-extensions-except=$ExtensionPath",
    "--load-extension=$ExtensionPath",
    $url
)
if ($Headed) {
    $chromeArgs = @('--window-position=-2400,-2400', '--window-size=900,700') + $chromeArgs
} else {
    $chromeArgs = @('--headless=new') + $chromeArgs
}

$proc = Start-Process $chrome -ArgumentList $chromeArgs -PassThru

function Receive-Message([System.Net.WebSockets.ClientWebSocket]$ws) {
    $buffer = New-Object byte[] 262144
    $sb = New-Object System.Text.StringBuilder
    do {
        $seg = New-Object System.ArraySegment[byte] -ArgumentList @(, $buffer)
        $task = $ws.ReceiveAsync($seg, [System.Threading.CancellationToken]::None)
        $task.Wait()
        $res = $task.Result
        [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buffer, 0, $res.Count))
    } while (-not $res.EndOfMessage)
    return $sb.ToString()
}

$ws = $null
$script:msgId = 0
try {
    $targets = $null
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $targets = Invoke-RestMethod "http://127.0.0.1:$DebugPort/json/list" -TimeoutSec 2
            if ($targets) { break }
        } catch { }
    }
    if (-not $targets) { throw 'Cannot read Chrome DevTools targets.' }

    $page = $targets | Where-Object { $_.type -eq 'page' -and $_.url -like '*plain.html*' } | Select-Object -First 1
    if (-not $page) { $page = $targets | Where-Object { $_.type -eq 'page' } | Select-Object -First 1 }
    if (-not $page) { throw 'Test tab not found.' }

    Write-Output ('TARGET: ' + $page.url)
    foreach ($t in $targets) { Write-Output ('  target [' + $t.type + '] ' + $t.url) }

    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, [System.Threading.CancellationToken]::None).Wait()

    function Send-Cdp([string]$method, $params) {
        $script:msgId++
        $payload = @{ id = $script:msgId; method = $method; params = $params } | ConvertTo-Json -Depth 8 -Compress
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
        $seg = New-Object System.ArraySegment[byte] -ArgumentList @(, $bytes)
        $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).Wait()
        return $script:msgId
    }

    function Invoke-Eval([string]$expr) {
        $id = Send-Cdp 'Runtime.evaluate' @{ expression = $expr; returnByValue = $true; awaitPromise = $true }
        while ($true) {
            $raw = Receive-Message $ws
            $obj = $raw | ConvertFrom-Json
            if ($obj.id -eq $id) {
                if ($obj.result.exceptionDetails) { return ('EXCEPTION: ' + ($obj.result.exceptionDetails.text)) }
                return $obj.result.result.value
            }
        }
    }

    Start-Sleep -Seconds 2

    $step1 = 'JSON.stringify({host: !!document.getElementById("bsa-host"), panel: !!document.getElementById("bsa-host").shadowRoot.querySelector(".bsa-wrap"), boxes: document.querySelectorAll("input[type=checkbox]").length})'
    Write-Output ('STEP1 inject: ' + (Invoke-Eval $step1))

    $step2 = 'document.getElementById("bsa-host").shadowRoot.querySelector(".bsa-btn.primary").click(), "ok"'
    Write-Output ('STEP2 click-select-all: ' + (Invoke-Eval $step2))

    $statusExpr = 'document.getElementById("bsa-host").shadowRoot.querySelector(".bsa-status").textContent + " | disabled=" + document.getElementById("bsa-host").shadowRoot.querySelector(".bsa-btn.primary").hasAttribute("disabled")'
    for ($k = 1; $k -le 30; $k++) {
        Start-Sleep -Milliseconds 300
        $st = Invoke-Eval $statusExpr
        Write-Output ("poll$k " + $st)
        if ($st -match 'disabled=false') { break }
    }

    $step3 = 'JSON.stringify(Array.prototype.map.call(document.querySelectorAll("input[type=checkbox]"), function(c){return c.checked;}))'
    Write-Output ('STEP3 states: ' + (Invoke-Eval $step3))

    $step5 = 'Array.prototype.slice.call(document.getElementById("bsa-host").shadowRoot.querySelectorAll(".bsa-btn")).filter(function(b){return b.getAttribute("data-act")==="clear";})[0].click(), "ok"'
    Write-Output ('STEP5 click-clear: ' + (Invoke-Eval $step5))
    for ($k = 1; $k -le 30; $k++) {
        Start-Sleep -Milliseconds 300
        $st = Invoke-Eval $statusExpr
        Write-Output ("clearpoll$k " + $st)
        if ($st -match 'disabled=false') { break }
    }

    Write-Output ('STEP6 states: ' + (Invoke-Eval $step3))
}
catch {
    Write-Output ('FAILED: ' + $_.Exception.Message)
}
finally {
    if ($ws) { try { $ws.Dispose() } catch { } }
    try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
    try { Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue } catch { }
    try { Remove-Item -LiteralPath $profileDir -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}
