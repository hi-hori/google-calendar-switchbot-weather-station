/**
 * Google Calendar の「今日」の予定を SwitchBot Weather Station の
 * カスタムページへ送る Google Apps Script です。
 *
 * 認証情報は Apps Script の Script Properties に保存します。
 */

const SWITCHBOT_API_BASE = 'https://api.switch-bot.com/v1.1';
const SWITCHBOT_CUSTOM_PAGE_MAX_BYTES = 300;
const TRIGGER_HANDLER = 'sendTodaysCalendarToSwitchBot';
const CALENDAR_UPDATE_TRIGGER_HANDLER = 'handleCalendarUpdate';
const LOG_CALENDAR_TEXT = true;
const FUTURE_LOOKAHEAD_DAYS = 30; // 明日から何日先まで「次の予定」を探すか
const MAX_UPCOMING_EVENTS_TO_SHOW = 3;
const MAX_UPCOMING_DAYS_TO_SHOW = 2;

/** 今日の予定を取得、整形して SwitchBot へ送信します。 */
function sendTodaysCalendarToSwitchBot() {
  log_('送信処理を開始しました。');
  const properties = getRequiredProperties_();
  const timezone = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  log_('スプレッドシートのタイムゾーン: ' + timezone + ' / deviceId: ' + maskId_(properties.SWITCHBOT_DEVICE_ID));
  const calendar = properties.GOOGLE_CALENDAR_ID
    ? CalendarApp.getCalendarById(properties.GOOGLE_CALENDAR_ID)
    : CalendarApp.getDefaultCalendar();

  if (!calendar) {
    throw new Error('指定した GOOGLE_CALENDAR_ID のカレンダーが見つかりません。');
  }

  const today = new Date();
  log_('カレンダー「' + calendar.getName() + '」から本日 (' + Utilities.formatDate(today, timezone, 'yyyy-MM-dd') + ') の予定を取得します。');
  const todaysEvents = getEventsForDay_(calendar, today);
  log_('本日の予定数: ' + todaysEvents.length + ' / 明日以降 ' + FUTURE_LOOKAHEAD_DAYS + ' 日以内の直近予定を探します。');
  const calendarText = formatSchedule_(calendar, today, timezone);
  if (LOG_CALENDAR_TEXT) log_('送信前の予定テキスト:\n' + calendarText);
  const response = sendCustomPage_(calendarText, properties);

  log_('送信完了。SwitchBot 応答: ' + response.getContentText());
  return calendarText;
}

/**
 * SwitchBot に送る前の予定テキストをログで確認するための関数です。
 * API 呼び出しは行いません。
 */
function previewTodaysCalendarText() {
  log_('プレビュー処理を開始しました（SwitchBot には送信しません）。');
  const properties = PropertiesService.getScriptProperties().getProperties();
  const timezone = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const calendar = properties.GOOGLE_CALENDAR_ID
    ? CalendarApp.getCalendarById(properties.GOOGLE_CALENDAR_ID)
    : CalendarApp.getDefaultCalendar();
  const text = formatSchedule_(calendar, new Date(), timezone);
  log_('プレビュー結果:\n' + text);
  return text;
}

/**
 * SwitchBot アカウントに登録されたデバイス一覧を実行ログへ出します。
 * 全デバイスの名前・種別・IDを実行ログへ出します。Weather Station 本体に一致する
 * deviceId を Script Properties の SWITCHBOT_DEVICE_ID に設定してください。
 */
function listSwitchBotDevices() {
  log_('SwitchBot デバイス一覧の取得を開始しました。');
  const properties = PropertiesService.getScriptProperties().getProperties();
  const requiredKeys = ['SWITCHBOT_TOKEN', 'SWITCHBOT_SECRET'];
  const missingKeys = requiredKeys.filter((key) => !properties[key] || properties[key].startsWith('YOUR_'));
  if (missingKeys.length) {
    throw new Error('Script Properties が未設定です: ' + missingKeys.join(', '));
  }

  const timestamp = String(Date.now());
  const nonce = Utilities.getUuid();
  const signature = Utilities.base64Encode(Utilities.computeHmacSha256Signature(
    properties.SWITCHBOT_TOKEN + timestamp + nonce,
    properties.SWITCHBOT_SECRET
  ));
  const response = UrlFetchApp.fetch(SWITCHBOT_API_BASE + '/devices', {
    method: 'get',
    headers: {
      Authorization: properties.SWITCHBOT_TOKEN,
      sign: signature,
      t: timestamp,
      nonce: nonce,
    },
    muteHttpExceptions: true,
  });

  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    log_('デバイス一覧の取得に失敗しました。HTTP ' + response.getResponseCode());
    throw new Error('SwitchBot API エラー (' + response.getResponseCode() + '): ' + response.getContentText());
  }

  const payload = JSON.parse(response.getContentText());
  const devices = (payload.body && payload.body.deviceList) || [];
  const deviceSummary = devices.map((device) => ({
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    deviceType: device.deviceType,
    enableCloudService: device.enableCloudService,
    hubDeviceId: device.hubDeviceId,
  }));
  const weatherStations = devices.filter((device) =>
    device.deviceType === 'WoIOSensor' ||
    /(weather station|daily station|デイリーステーション|ウェザーステーション)/i.test(device.deviceName || '')
  );
  log_('登録済みデバイス数: ' + devices.length);
  log_('全デバイス一覧:\n' + JSON.stringify(deviceSummary, null, 2));
  log_('Weather Station 参考候補（機種名を必ず確認）:\n' + JSON.stringify(weatherStations, null, 2));
  return weatherStations;
}

/** 毎日指定時刻（スクリプトのタイムゾーン）に更新するトリガーを作成します。 */
function createDailyTrigger() {
  log_('毎日実行トリガーを作成します。');
  deleteDailyTriggers_();
  const trigger = ScriptApp.newTrigger(TRIGGER_HANDLER)
    .timeBased()
    .atHour(1)
    .everyDays(1)
    .create();
  log_('トリガーを作成しました。handler: ' + trigger.getHandlerFunction() + ' / ID: ' + trigger.getUniqueId());
}

/** このスクリプトが作成した毎日更新トリガーだけを削除します。 */
function deleteDailyTriggers() {
  log_('毎日実行トリガーを削除します。');
  deleteDailyTriggers_();
  log_('トリガーを削除しました。');
}

/**
 * カレンダーの予定作成・変更・削除で画面を更新するトリガーを作成します。
 * 日付が変わるだけでは発火しないため、createDailyTrigger() も併用してください。
 */
function createCalendarUpdateTrigger() {
  const calendarId = getTargetCalendarId_();
  log_('カレンダー更新トリガーを作成します。calendarId: ' + maskId_(calendarId));
  deleteCalendarUpdateTriggers_();
  const trigger = ScriptApp.newTrigger(CALENDAR_UPDATE_TRIGGER_HANDLER)
    .forUserCalendar(calendarId)
    .onEventUpdated()
    .create();
  log_('カレンダー更新トリガーを作成しました。ID: ' + trigger.getUniqueId());
}

/** カレンダー変更時にトリガーから呼ばれます。手動実行は不要です。 */
function handleCalendarUpdate(event) {
  log_('カレンダーの更新を検知しました。calendarId: ' + maskId_(event && event.calendarId));
  return sendTodaysCalendarToSwitchBot();
}

/** カレンダー更新トリガーだけを削除します。 */
function deleteCalendarUpdateTriggers() {
  log_('カレンダー更新トリガーを削除します。');
  deleteCalendarUpdateTriggers_();
  log_('カレンダー更新トリガーを削除しました。');
}

function formatSchedule_(calendar, startDate, timezone) {
  const todaysEvents = getEventsForDay_(calendar, startDate);
  const lines = todaysEvents.length > 0
    ? [formatDaySchedule_(todaysEvents, startDate, timezone, '本日の予定', todaysEvents.length)]
    : [];
  const upcomingEvents = getUpcomingEvents_(calendar, startDate);

  if (upcomingEvents.length > 0) {
    lines.push(formatUpcomingSchedule_(upcomingEvents, timezone));
  } else {
    lines.push('翌日以降の予定はありません');
  }
  return lines.join('\n');
}

function formatDaySchedule_(events, date, timezone, heading, maxEventsToShow) {
  const japaneseWeekdays = ['日', '月', '火', '水', '木', '金', '土'];
  const dateLabel = Utilities.formatDate(date, timezone, 'M/d') + ' (' + japaneseWeekdays[date.getDay()] + ')';
  const lines = [heading + ' ' + dateLabel];
  if (events.length === 0) {
    lines.push('予定はありません');
    return lines.join('\n');
  }

  events.slice(0, maxEventsToShow).forEach((event) => {
    const time = event.isAllDayEvent()
      ? ''
      : Utilities.formatDate(event.getStartTime(), timezone, 'HH:mm') +
        '–' + Utilities.formatDate(event.getEndTime(), timezone, 'HH:mm');
    lines.push('・' + (time ? time + ' ' : '') + event.getTitle());
  });
  if (events.length > maxEventsToShow) {
    lines.push('・ほか' + (events.length - maxEventsToShow) + '件');
  }
  return lines.join('\n');
}

function formatUpcomingSchedule_(upcomingEvents, timezone) {
  const japaneseWeekdays = ['日', '月', '火', '水', '木', '金', '土'];
  const lines = ['翌日以降の予定'];

  upcomingEvents.forEach(({event, date}) => {
    const dateLabel = Utilities.formatDate(date, timezone, 'M/d') + ' (' + japaneseWeekdays[date.getDay()] + ')';
    const time = event.isAllDayEvent()
      ? ''
      : Utilities.formatDate(event.getStartTime(), timezone, 'HH:mm') + ' ';
    lines.push('・' + dateLabel + ' ' + time + event.getTitle());
  });
  return lines.join('\n');
}

function getEventsForDay_(calendar, date) {
  return calendar.getEventsForDay(date)
    .sort((a, b) => a.getStartTime().getTime() - b.getStartTime().getTime());
}

function getUpcomingEvents_(calendar, startDate) {
  const upcomingEvents = [];
  let scheduledDayCount = 0;
  for (let daysAfterToday = 1; daysAfterToday <= FUTURE_LOOKAHEAD_DAYS; daysAfterToday += 1) {
    const date = new Date(startDate.getTime());
    date.setDate(date.getDate() + daysAfterToday);
    const events = getEventsForDay_(calendar, date);
    if (events.length === 0) continue;

    scheduledDayCount += 1;
    for (const event of events) {
      upcomingEvents.push({event: event, date: date});
      if (upcomingEvents.length === MAX_UPCOMING_EVENTS_TO_SHOW) {
        log_('翌日以降の予定を ' + upcomingEvents.length + ' 件、' + scheduledDayCount + ' 日分取得しました。');
        return upcomingEvents;
      }
    }
    if (scheduledDayCount === MAX_UPCOMING_DAYS_TO_SHOW) {
      log_('翌日以降の予定を ' + upcomingEvents.length + ' 件、' + scheduledDayCount + ' 日分取得しました。');
      return upcomingEvents;
    }
  }
  log_(upcomingEvents.length
    ? '翌日以降の予定を ' + upcomingEvents.length + ' 件、' + scheduledDayCount + ' 日分取得しました。'
    : '直近 ' + FUTURE_LOOKAHEAD_DAYS + ' 日以内に翌日以降の予定はありません。');
  return upcomingEvents;
}

function sendCustomPage_(calendarText, properties) {
  // カスタムページは改行を含むプレーンテキストを受け取れるため、そのまま送信します。
  const limitedText = limitDisplayText_(calendarText);
  const displayText = limitedText.text;
  const sourceBytes = limitedText.sourceBytes;
  const displayBytes = Utilities.newBlob(displayText).getBytes().length;
  log_('表示用テキストを作成しました。元: ' + sourceBytes + ' bytes / 送信: ' + displayBytes + ' bytes' +
    (limitedText.wasTruncated ? '（300 bytes に切り詰め、「…（省略）」を付加）' : ''));
  const timestamp = String(Date.now());
  const nonce = Utilities.getUuid();
  const signatureBytes = Utilities.computeHmacSha256Signature(
    properties.SWITCHBOT_TOKEN + timestamp + nonce,
    properties.SWITCHBOT_SECRET
  );
  const signature = Utilities.base64Encode(signatureBytes);
  const url = SWITCHBOT_API_BASE + '/devices/' + encodeURIComponent(properties.SWITCHBOT_DEVICE_ID) + '/commands';
  log_('SwitchBot カスタムページ更新 API を呼び出します。');
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: properties.SWITCHBOT_TOKEN,
      sign: signature,
      t: timestamp,
      nonce: nonce,
    },
    payload: JSON.stringify({
      command: 'customPage',
      parameter: displayText,
      commandType: 'command',
    }),
    muteHttpExceptions: true,
  });

  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    log_('カスタムページ更新に失敗しました。HTTP ' + response.getResponseCode());
    throw new Error('SwitchBot API エラー (' + response.getResponseCode() + '): ' + response.getContentText());
  }
  log_('カスタムページ更新 API は HTTP ' + response.getResponseCode() + ' を返しました。');
  return response;
}

function limitDisplayText_(text) {
  const sourceBytes = Utilities.newBlob(text).getBytes().length;
  if (sourceBytes <= SWITCHBOT_CUSTOM_PAGE_MAX_BYTES) {
    return {text: text, sourceBytes: sourceBytes, wasTruncated: false};
  }

  const omissionLabel = '\n…（省略）';
  const labelBytes = Utilities.newBlob(omissionLabel).getBytes().length;
  return {
    text: truncateUtf8_(text, SWITCHBOT_CUSTOM_PAGE_MAX_BYTES - labelBytes) + omissionLabel,
    sourceBytes: sourceBytes,
    wasTruncated: true,
  };
}

function truncateUtf8_(text, maxBytes) {
  let result = '';
  for (const character of text) {
    const candidate = result + character;
    if (Utilities.newBlob(candidate).getBytes().length > maxBytes) break;
    result = candidate;
  }
  return result;
}

function getRequiredProperties_() {
  const properties = PropertiesService.getScriptProperties().getProperties();
  const requiredKeys = ['SWITCHBOT_TOKEN', 'SWITCHBOT_SECRET', 'SWITCHBOT_DEVICE_ID'];
  const missingKeys = requiredKeys.filter((key) => !properties[key] || properties[key].startsWith('YOUR_'));
  if (missingKeys.length) {
    log_('必須の Script Properties が未設定です: ' + missingKeys.join(', '));
    throw new Error('Script Properties が未設定です: ' + missingKeys.join(', '));
  }
  log_('必須の Script Properties が設定済みであることを確認しました。');
  return properties;
}

function getTargetCalendarId_() {
  const configuredCalendarId = PropertiesService.getScriptProperties().getProperty('GOOGLE_CALENDAR_ID');
  return configuredCalendarId || CalendarApp.getDefaultCalendar().getId();
}

function deleteDailyTriggers_() {
  const triggers = ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === TRIGGER_HANDLER);
  triggers.forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  log_('既存トリガーを ' + triggers.length + ' 件削除しました。');
}

function deleteCalendarUpdateTriggers_() {
  const triggers = ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === CALENDAR_UPDATE_TRIGGER_HANDLER);
  triggers.forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  log_('既存のカレンダー更新トリガーを ' + triggers.length + ' 件削除しました。');
}

function maskId_(value) {
  if (!value || value.length <= 4) return '****';
  return '****' + value.slice(-4);
}

function log_(message) {
  Logger.log('[CalToBot] ' + message);
}
