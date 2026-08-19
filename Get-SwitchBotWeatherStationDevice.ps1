<#
SwitchBot アカウントの Weather Station の deviceId を取得します。

実行例:
  powershell -ExecutionPolicy Bypass -File .\Get-SwitchBotWeatherStationDevice.ps1

Token と Secret は対話的に入力します。スクリプト・履歴には保存しません。
#>

$ErrorActionPreference = 'Stop'

function ConvertFrom-SecureStringPlainText {
    param([Parameter(Mandatory)] [Security.SecureString] $SecureString)

    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureString)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

# Windows PowerShell 5.1 環境でも TLS 1.2 を使えるようにする。
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$token = Read-Host 'SwitchBot Token'
$secretInput = Read-Host 'SwitchBot Secret' -AsSecureString
$secret = ConvertFrom-SecureStringPlainText -SecureString $secretInput

try {
    $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
    $nonce = [Guid]::NewGuid().ToString()
    $toSign = $token + $timestamp + $nonce

    $keyBytes = [Text.Encoding]::UTF8.GetBytes($secret)
    $dataBytes = [Text.Encoding]::UTF8.GetBytes($toSign)
    $hmac = [Security.Cryptography.HMACSHA256]::new($keyBytes)
    try {
        $signature = [Convert]::ToBase64String($hmac.ComputeHash($dataBytes))
    }
    finally {
        $hmac.Dispose()
    }

    $headers = @{
        Authorization = $token
        sign          = $signature
        t             = $timestamp
        nonce         = $nonce
    }
    $response = Invoke-RestMethod -Method Get -Uri 'https://api.switch-bot.com/v1.1/devices' -Headers $headers
    $devices = @($response.body.deviceList)

    Write-Host "`nWeather Station 候補（deviceType = WoIOSensor）:" -ForegroundColor Cyan
    $candidates = @($devices | Where-Object { $_.deviceType -eq 'WoIOSensor' })
    if ($candidates.Count -eq 0) {
        Write-Warning 'WoIOSensor は見つかりませんでした。下の全デバイス一覧で deviceType と名前を確認してください。'
    }
    $candidates | Select-Object deviceName, deviceType, deviceId, hubDeviceId | Format-List

    Write-Host "`n全デバイス一覧:" -ForegroundColor Cyan
    $devices | Select-Object deviceName, deviceType, deviceId | Format-Table -AutoSize
}
finally {
    # 以降の処理で誤って表示・再利用しないよう、変数を空にする。
    $secret = $null
}
