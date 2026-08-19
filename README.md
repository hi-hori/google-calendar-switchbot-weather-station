# Calendar to SwitchBot Weather Station

Google スプレッドシートに紐づく Apps Script で、Google カレンダーの当日予定を SwitchBot Weather Station のカスタムページへ送ります。

## 開発について

このリポジトリのコードは OpenAI Codex を用いて生成されました。

## セットアップ

1. 対象の Google スプレッドシートで **拡張機能 → Apps Script** を開き、`Code.gs` の内容を貼り付けて保存します。
2. SwitchBot アプリで開発者用の Token / Secret を取得します。アプリの **プロフィール → 設定 → アプリについて** から、アプリバージョンを複数回タップして開発者向けオプションを開けます。
3. `listSwitchBotDevices()` を実行し、実行ログの **全デバイス一覧** から、Weather Station 本体と同じ `deviceName` の `deviceId` を確認します。`WoIOSensor` は他の温湿度計にも使われるため、`deviceType` だけでは判定しません。その ID を、Apps Script の **プロジェクトの設定 → スクリプト プロパティ** にある `SWITCHBOT_DEVICE_ID` の値として設定します。
4. Apps Script の **プロジェクトの設定 → スクリプト プロパティ** で次の値を登録します。`GOOGLE_CALENDAR_ID` は任意で、未設定ならメイン カレンダーを使います。

   - `SWITCHBOT_TOKEN`
   - `SWITCHBOT_SECRET`
   - `SWITCHBOT_DEVICE_ID`
   - `GOOGLE_CALENDAR_ID`（任意）
5. `previewTodaysCalendarText()` を実行して、実行ログに予定が改行付きで出ることを確認します。
6. `sendTodaysCalendarToSwitchBot()` を実行して実機へ送ります。Weather Station 側でカスタムページを表示してください。
7. 予定の作成・編集・削除時にも更新するには、`createCalendarUpdateTrigger()` を一度実行します。初回のみカレンダーとトリガー管理の権限を許可してください。
8. 日付が変わるだけではカレンダー更新トリガーは動かないため、`createDailyTrigger()` も一度実行します。現在は午前1〜2時ごろに動く設定です。時刻は `atHour(1)` を変更してください。

カレンダー変更トリガーは、どの予定が変わったかではなく「カレンダーが更新された」ことを通知します。このスクリプトでは通知を受けると、対象日の予定を再取得して画面全体を更新します。

## Windows から Device ID だけを調べる

Google Apps Script を使わずに調べる場合は、PowerShell で次を実行します。

```powershell
cd C:\Work\Switchbot\CalToBot
powershell -ExecutionPolicy Bypass -File .\Get-SwitchBotWeatherStationDevice.ps1
```

Token と Secret は画面上で入力します（Secret は入力時に表示されません）。出力された `deviceType = WoIOSensor` の `deviceId` が Weather Station の ID です。Token / Secret は貼り付け先のスクリプトやコマンド履歴へ保存されません。

## 表示仕様

Weather Station のカスタムページへは、予定を改行付きプレーンテキストのまま送信します。UTF-8 で約300バイトを超えた場合は、文字の途中で壊れないよう先頭側から切り詰め、末尾に `…（省略）` を表示します。日本語予定が多い日は先頭側だけが表示されます。

今日の予定は全件を時刻順に表示します。明日以降は、直近で予定が入っている日だけを表示し、その日から時刻順で最大2件を表示します。予定が2件以上ある場合は件数も表示し、さらに予定がある場合は `ほかN件` と表示します。探す範囲は `FUTURE_LOOKAHEAD_DAYS`（初期値30日）で変更できます。

Token / Secret はスクリプトのソースではなく Script Properties に保存してください。`setSecrets()` は認証情報をコードに保存しないための案内用関数であり、実行不要です。

## 実行ログの確認

各処理段階を `Logger` に記録します。Apps Script エディタ左側の **実行数** から対象の実行を開くと、手動実行・定期実行のどちらのログも確認できます。`LOG_CALENDAR_TEXT` は初期値が `true` で、予定タイトルを含む送信前テキストもログに記録します。予定名をログへ残したくない場合は `false` に変更してください。Token と Secret はログへ出力しません。

参考: [SwitchBot の公式カスタムページ案内](https://support.switch-bot.com/hc/ja/articles/40319207776919-%E9%96%8B%E7%99%BA%E8%80%85%E5%90%91%E3%81%91%E3%82%AA%E3%83%97%E3%82%B7%E3%83%A7%E3%83%B3-%E3%83%87%E3%82%A4%E3%83%AA%E3%83%BC%E3%82%B9%E3%83%86%E3%83%BC%E3%82%B7%E3%83%A7%E3%83%B3%E3%82%AB%E3%82%B9%E3%82%BF%E3%83%A0%E3%83%9A%E3%83%BC%E3%82%B8%E3%81%AE%E8%A8%AD%E5%AE%9A%E6%96%B9%E6%B3%95)
