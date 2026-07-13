/**
 * ==============================================================
 * 摂取カロリー自動記録システム - GAS バックエンド
 * ==============================================================
 *
 * 【事前設定】スクリプトプロパティ（拡張機能 > Apps Script > プロジェクトの設定 > スクリプト プロパティ）に
 * 以下を設定してください。コードには直書きしません。
 *
 *   GEMINI_API_KEY  : Google AI Studio で発行した Gemini APIキー（必須）
 *   SHEET_ID        : 記録先スプレッドシートのID（未設定ならこのスクリプトに
 *                      バインドされたスプレッドシートを使用）
 *   DRIVE_FOLDER_ID : 食事写真を保存するGoogle DriveフォルダID（任意。未設定なら画像は保存しない）
 *
 * 【Webアプリのデプロイ設定】
 *   実行するユーザー : 自分（スクリプト所有者）
 *   アクセスできるユーザー : 全員（匿名ユーザーを含む）
 * ==============================================================
 */

const SHEET_NAME = '摂取カロリー記録';
const GEMINI_MODEL = 'gemini-2.5-flash'; // 費用対効果の良い現行の安定版マルチモーダルモデル
const HEADER_ROW = ['日付', '時刻', '料理名', 'カロリー(kcal)', 'たんぱく質(g)', '脂質(g)', '炭水化物(g)', '画像URL', '備考'];

/**
 * 写真を受け取り解析してスプレッドシートに記録する
 * リクエストボディ(JSON文字列): { "image": "base64文字列（プレフィックス無し）", "mimeType": "image/jpeg" }
 *
 * ブラウザからのCORSプリフライトを避けるため、クライアント側は
 * Content-Type: text/plain で送信すること（GAS側では中身をJSONとしてパースする）
 */
function doPost(e) {
  const output = ContentService.createTextOutput().setMimeType(ContentService.MimeType.JSON);

  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error('リクエストボディが空です');
    }

    const payload = JSON.parse(e.postData.contents);
    const base64Image = payload.image;
    const mimeType = payload.mimeType || 'image/jpeg';

    if (!base64Image) {
      throw new Error('画像データが送信されていません');
    }
    if (['image/jpeg', 'image/png', 'image/webp', 'image/heic'].indexOf(mimeType) === -1) {
      throw new Error('対応していない画像形式です: ' + mimeType);
    }

    // 1. Gemini APIで画像を解析
    const analysis = analyzeFoodImage_(base64Image, mimeType);

    // 2. Google Driveに画像を保存（DRIVE_FOLDER_ID未設定時はスキップ）
    let imageUrl = '';
    try {
      imageUrl = saveImageToDrive_(base64Image, mimeType);
    } catch (driveErr) {
      // 画像保存に失敗しても記録自体は続行する
      console.warn('Driveへの画像保存に失敗しました: ' + driveErr.message);
    }

    // 3. スプレッドシートの最終行に追記
    appendRecord_(analysis, imageUrl);

    output.setContent(JSON.stringify({
      status: 'success',
      data: analysis,
      imageUrl: imageUrl
    }));
  } catch (err) {
    output.setContent(JSON.stringify({
      status: 'error',
      message: err.message
    }));
  }

  return output;
}

/**
 * 本日分の記録一覧を取得する（フロントエンドの履歴表示・合計カロリー表示用）
 */
function doGet(e) {
  const output = ContentService.createTextOutput().setMimeType(ContentService.MimeType.JSON);

  try {
    const sheet = getSheet_();
    if (sheet.getLastRow() < 2) {
      output.setContent(JSON.stringify({ status: 'success', data: [] }));
      return output;
    }

    const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADER_ROW.length).getValues();

    const records = values
      .filter(function (row) { return row[0] === today; })
      .map(function (row) {
        return {
          date: row[0], time: row[1], foodName: row[2],
          calories: row[3], protein: row[4], fat: row[5], carbs: row[6],
          imageUrl: row[7], note: row[8]
        };
      })
      // 新しい記録を先頭に
      .reverse();

    output.setContent(JSON.stringify({ status: 'success', data: records }));
  } catch (err) {
    output.setContent(JSON.stringify({ status: 'error', message: err.message }));
  }

  return output;
}

/**
 * Gemini APIに画像＋プロンプトを送信し、料理名・カロリー・PFCをJSONで取得する
 */
function analyzeFoodImage_(base64Image, mimeType) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('スクリプトプロパティに GEMINI_API_KEY が設定されていません');
  }

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent';

  const prompt =
    'あなたは管理栄養士です。添付された食事の写真を見て、日本の一般的な食事を基準に' +
    '料理名・推定カロリー・PFC（たんぱく質/脂質/炭水化物）を推定してください。\n' +
    '複数の料理が写っている場合は、写真全体の合計値として推定してください。\n' +
    '写真が食事ではない、または料理を判別できない場合は recognized を false にしてください。\n' +
    '出力は必ず次のJSON形式のみとし、説明文やMarkdownは一切含めないでください。\n' +
    '{\n' +
    '  "recognized": true,\n' +
    '  "foodName": "料理名（日本語、20文字以内）",\n' +
    '  "calories": 数値（kcal、整数）,\n' +
    '  "protein": 数値（g、小数1桁）,\n' +
    '  "fat": 数値（g、小数1桁）,\n' +
    '  "carbs": 数値（g、小数1桁）,\n' +
    '  "note": "推定根拠や補足。目安値であることが分かる一言（30文字程度）"\n' +
    '}';

  const requestBody = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: base64Image } }
      ]
    }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json'
    }
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': apiKey },
    payload: JSON.stringify(requestBody),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  const text = response.getContentText();

  if (code !== 200) {
    throw new Error('Gemini APIエラー (HTTP ' + code + '): ' + text.substring(0, 300));
  }

  const json = JSON.parse(text);
  const candidate = json.candidates && json.candidates[0];
  const part = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0];

  if (!part || !part.text) {
    // セーフティフィルタ等でブロックされた場合
    const blockReason = json.promptFeedback && json.promptFeedback.blockReason;
    throw new Error('Gemini APIから有効な応答が得られませんでした' + (blockReason ? '（理由: ' + blockReason + '）' : ''));
  }

  let parsed;
  try {
    parsed = JSON.parse(part.text);
  } catch (parseErr) {
    // 稀にコードブロック等が混入した場合の救済措置
    const match = part.text.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error('AIの応答をJSONとして解析できませんでした');
    }
    parsed = JSON.parse(match[0]);
  }

  if (!parsed.recognized) {
    throw new Error('画像から食事を認識できませんでした。別の角度・明るい場所で撮り直してお試しください。');
  }

  return {
    foodName: String(parsed.foodName || '不明').substring(0, 40),
    calories: Math.round(Number(parsed.calories) || 0),
    protein: roundTo1_(parsed.protein),
    fat: roundTo1_(parsed.fat),
    carbs: roundTo1_(parsed.carbs),
    note: String(parsed.note || '').substring(0, 100)
  };
}

function roundTo1_(value) {
  const n = Number(value) || 0;
  return Math.round(n * 10) / 10;
}

/**
 * 画像をGoogle Driveに保存し、閲覧用URLを返す。DRIVE_FOLDER_ID未設定時は空文字を返す。
 */
function saveImageToDrive_(base64Image, mimeType) {
  const folderId = PropertiesService.getScriptProperties().getProperty('DRIVE_FOLDER_ID');
  if (!folderId) return '';

  const folder = DriveApp.getFolderById(folderId);
  const decoded = Utilities.base64Decode(base64Image);
  const ext = mimeType.split('/')[1] || 'jpg';
  const fileName = 'meal_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss') + '.' + ext;
  const blob = Utilities.newBlob(decoded, mimeType, fileName);
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}

/**
 * スプレッドシートの最終行に1件追記する
 */
function appendRecord_(analysis, imageUrl) {
  const sheet = getSheet_();
  const now = new Date();

  sheet.appendRow([
    Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd'),
    Utilities.formatDate(now, 'Asia/Tokyo', 'HH:mm:ss'),
    analysis.foodName,
    analysis.calories,
    analysis.protein,
    analysis.fat,
    analysis.carbs,
    imageUrl,
    analysis.note
  ]);
}

/**
 * 記録用シートを取得（無ければヘッダー付きで新規作成）
 */
function getSheet_() {
  const sheetId = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  const ss = sheetId ? SpreadsheetApp.openById(sheetId) : SpreadsheetApp.getActiveSpreadsheet();

  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADER_ROW);
    sheet.getRange(1, 1, 1, HEADER_ROW.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * 動作確認用：スクリプトエディタから実行してAPIキー疎通を確認する
 * （実行 > testGeminiConnection を選択して実行）
 */
function testGeminiConnection() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  Logger.log(apiKey ? 'GEMINI_API_KEY は設定されています（' + apiKey.substring(0, 4) + '...）' : 'GEMINI_API_KEY が未設定です');
}
