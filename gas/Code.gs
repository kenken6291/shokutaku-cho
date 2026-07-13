/**
 * ==============================================================
 * 摂取カロリー・からだ記録システム - GAS バックエンド
 * ==============================================================
 *
 * 【できること】
 *   1. 食事写真からAIでカロリー・PFCを解析してスプレッドシートに記録（複数人対応）
 *   2. 性別・年齢・身長・活動レベルからなる「からだプロフィール」を保存
 *   3. 体重を記録（1日1件、当日分は上書き更新）
 *   4. 基礎代謝（BMR）・消費エネルギー目安（TDEE）・本日のエネルギー収支を算出
 *      → 基礎代謝基準値・身体活動レベルは、厚生労働省「日本人の食事摂取基準（2020年版）」の
 *        公表値を使用しています。あくまで目安であり、個人差があります。
 *   5. 「100日チャレンジ」：開始日から100日間の進捗・継続記録日数・連続記録日数を
 *      成長するキャラクターと一緒に表示し、25/50/75/100%達成時に自分で決めたメッセージを表示
 *
 * 【事前設定】スクリプトプロパティ（プロジェクトの設定 > スクリプト プロパティ）
 *   GEMINI_API_KEY  : Google AI Studio で発行したGemini APIキー（必須）
 *   SHEET_ID        : 記録先スプレッドシートのID（未設定ならバインド先スプレッドシートを使用）
 *   DRIVE_FOLDER_ID : 食事写真を保存するGoogle DriveフォルダID（任意）
 *
 * 【Webアプリのデプロイ設定】
 *   実行するユーザー: 自分（スクリプト所有者）
 *   アクセスできるユーザー: 全員（匿名ユーザーを含む）
 * ==============================================================
 */

const MEAL_SHEET_NAME = '摂取カロリー記録';
const PROFILE_SHEET_NAME = 'プロフィール';
const WEIGHT_SHEET_NAME = '体重記録';
const USER_SHEET_NAME = '利用者一覧';
const CHALLENGE_SHEET_NAME = 'チャレンジ';
const DIARY_SHEET_NAME = 'ひとこと日記';
const GEMINI_MODEL = 'gemini-3.5-flash'; // 現行の安定版フラッグシップモデル（2026年7月時点）
const CHALLENGE_TOTAL_DAYS = 100;

const MEAL_HEADER = ['名前', '日付', '時刻', '料理名', 'カロリー(kcal)', 'たんぱく質(g)', '脂質(g)', '炭水化物(g)', '画像URL', '備考'];
const PROFILE_HEADER = ['名前', '性別', '年齢', '身長(cm)', '活動レベル', '更新日時'];
const WEIGHT_HEADER = ['名前', '日付', '体重(kg)', '登録時刻'];
const USER_HEADER = ['名前', '登録日時'];
const CHALLENGE_HEADER = ['名前', '開始日', 'メッセージ25', 'メッセージ50', 'メッセージ75', 'メッセージ100', '更新日時'];
const DIARY_HEADER = ['名前', '日付', 'ひとこと'];

/**
 * 基礎代謝基準値（kcal/kg体重/日）
 * 出典: 厚生労働省「日本人の食事摂取基準（2020年版）」
 */
const BMR_TABLE = [
  { min: 1, max: 2, male: 61.0, female: 59.7 },
  { min: 3, max: 5, male: 54.8, female: 52.2 },
  { min: 6, max: 7, male: 44.3, female: 41.9 },
  { min: 8, max: 9, male: 40.8, female: 38.3 },
  { min: 10, max: 11, male: 37.4, female: 34.8 },
  { min: 12, max: 14, male: 31.0, female: 29.6 },
  { min: 15, max: 17, male: 27.0, female: 25.3 },
  { min: 18, max: 29, male: 24.0, female: 21.7 },
  { min: 30, max: 49, male: 22.3, female: 20.7 },
  { min: 50, max: 69, male: 21.5, female: 20.7 },
  { min: 70, max: 200, male: 21.5, female: 20.7 }
];

/**
 * 身体活動レベル（低い/ふつう/高い）
 * 出典: 厚生労働省「日本人の食事摂取基準（2020年版）」
 * 75歳以上は「高い」区分が設定されていないため、該当時は「ふつう」の値で代用する。
 */
const PAL_TABLE = [
  { min: 1, max: 2, low: 1.35, normal: 1.35, high: 1.35 },
  { min: 3, max: 5, low: 1.45, normal: 1.45, high: 1.45 },
  { min: 6, max: 7, low: 1.35, normal: 1.55, high: 1.75 },
  { min: 8, max: 9, low: 1.40, normal: 1.60, high: 1.80 },
  { min: 10, max: 11, low: 1.45, normal: 1.65, high: 1.85 },
  { min: 12, max: 14, low: 1.50, normal: 1.70, high: 1.90 },
  { min: 15, max: 17, low: 1.55, normal: 1.75, high: 1.95 },
  { min: 18, max: 29, low: 1.50, normal: 1.75, high: 2.00 },
  { min: 30, max: 49, low: 1.50, normal: 1.75, high: 2.00 },
  { min: 50, max: 64, low: 1.50, normal: 1.75, high: 2.00 },
  { min: 65, max: 74, low: 1.45, normal: 1.70, high: 1.95 },
  { min: 75, max: 200, low: 1.40, normal: 1.65, high: 1.65 } // 高いは未設定のためふつうで代用
];

/**
 * ==============================================================
 * エントリーポイント
 * ==============================================================
 */

/**
 * POSTリクエストを種別ごとに振り分ける。
 * リクエストボディ(JSON): { "type": "meal" | "profile" | "weight" | "register" | "challenge" | "diary", ... }
 * type省略時は "meal" として扱う（後方互換）。
 *
 * ブラウザからのCORSプリフライトを避けるため、クライアント側は
 * Content-Type: text/plain で送信すること。
 */
function doPost(e) {
  const output = ContentService.createTextOutput().setMimeType(ContentService.MimeType.JSON);

  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error('リクエストボディが空です');
    }
    const payload = JSON.parse(e.postData.contents);
    const type = payload.type || 'meal';

    let result;
    if (type === 'meal') {
      result = handleMealPost_(payload);
    } else if (type === 'profile') {
      result = handleProfilePost_(payload);
    } else if (type === 'weight') {
      result = handleWeightPost_(payload);
    } else if (type === 'register') {
      result = handleRegisterPost_(payload);
    } else if (type === 'challenge') {
      result = handleChallengePost_(payload);
    } else if (type === 'diary') {
      result = handleDiaryPost_(payload);
    } else {
      throw new Error('不明なリクエスト種別です: ' + type);
    }

    output.setContent(JSON.stringify(result));
  } catch (err) {
    output.setContent(JSON.stringify({ status: 'error', message: err.message }));
  }

  return output;
}

/**
 * ダッシュボード情報を取得する。
 * クエリパラメータ: ?userName=ニックネーム
 * 返す内容: プロフィール・最新体重・本日の食事記録・カロリー合計・基礎代謝・消費目安・収支
 */
function doGet(e) {
  const output = ContentService.createTextOutput().setMimeType(ContentService.MimeType.JSON);

  try {
    const userName = sanitizeUserName_(e && e.parameter && e.parameter.userName);
    const data = userName ? buildDashboard_(userName) : emptyDashboard_();
    output.setContent(JSON.stringify({ status: 'success', data: data }));
  } catch (err) {
    output.setContent(JSON.stringify({ status: 'error', message: err.message }));
  }

  return output;
}

/**
 * ==============================================================
 * POSTハンドラ
 * ==============================================================
 */

function handleMealPost_(payload) {
  const base64Image = payload.image;
  const mimeType = payload.mimeType || 'image/jpeg';
  const userName = sanitizeUserName_(payload.userName);

  if (!userName) throw new Error('ユーザー名が指定されていません');
  if (!base64Image) throw new Error('画像データが送信されていません');
  if (['image/jpeg', 'image/png', 'image/webp', 'image/heic'].indexOf(mimeType) === -1) {
    throw new Error('対応していない画像形式です: ' + mimeType);
  }

  const analysis = analyzeFoodImage_(base64Image, mimeType);

  let imageUrl = '';
  try {
    imageUrl = saveImageToDrive_(base64Image, mimeType, userName);
  } catch (driveErr) {
    console.warn('Driveへの画像保存に失敗しました: ' + driveErr.message);
  }

  appendMealRecord_(userName, analysis, imageUrl);

  return { status: 'success', data: analysis, imageUrl: imageUrl };
}

function handleProfilePost_(payload) {
  const userName = sanitizeUserName_(payload.userName);
  if (!userName) throw new Error('ユーザー名が指定されていません');

  const sex = payload.sex === 'male' ? 'male' : (payload.sex === 'female' ? 'female' : null);
  const age = Math.round(Number(payload.age));
  const heightCm = Math.round(Number(payload.heightCm) * 10) / 10;
  const palLevel = ['low', 'normal', 'high'].indexOf(payload.palLevel) !== -1 ? payload.palLevel : 'normal';

  if (!sex) throw new Error('性別を選択してください');
  if (!age || age < 1 || age > 120) throw new Error('年齢を正しく入力してください（1〜120）');
  if (!heightCm || heightCm < 50 || heightCm > 250) throw new Error('身長を正しく入力してください（50〜250cm）');

  upsertProfile_(userName, sex, age, heightCm, palLevel);

  return { status: 'success', data: { sex: sex, age: age, heightCm: heightCm, palLevel: palLevel } };
}

function handleWeightPost_(payload) {
  const userName = sanitizeUserName_(payload.userName);
  if (!userName) throw new Error('ユーザー名が指定されていません');

  const weightKg = Math.round(Number(payload.weightKg) * 10) / 10;
  if (!weightKg || weightKg < 20 || weightKg > 300) throw new Error('体重を正しく入力してください（20〜300kg）');

  upsertWeightToday_(userName, weightKg);

  return { status: 'success', data: { weightKg: weightKg } };
}

/**
 * ニックネームを新規登録する。既に使われているニックネームは拒否する。
 * （既にlocalStorageに保存済みの自分の名前で再訪問する場合はこのAPIは呼ばれない）
 */
function handleRegisterPost_(payload) {
  const userName = sanitizeUserName_(payload.userName);
  if (!userName) throw new Error('ニックネームを入力してください');

  if (isUserNameTaken_(userName)) {
    throw new Error('そのニックネームは既に使われています。別の名前をお試しください。');
  }

  registerUserName_(userName);
  return { status: 'success', data: { userName: userName } };
}

function isUserNameTaken_(userName) {
  const sheet = getOrCreateSheet_(USER_SHEET_NAME, USER_HEADER);
  if (sheet.getLastRow() < 2) return false;

  const names = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  const normalized = userName.toLowerCase();
  return names.some(function (row) { return String(row[0]).toLowerCase() === normalized; });
}

function registerUserName_(userName) {
  const sheet = getOrCreateSheet_(USER_SHEET_NAME, USER_HEADER);
  const now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  sheet.appendRow([userName, now]);
}

/**
 * 100日チャレンジの開始日・節目メッセージを保存する（ユーザーごとに1件、上書き更新）
 */
function handleChallengePost_(payload) {
  const userName = sanitizeUserName_(payload.userName);
  if (!userName) throw new Error('ユーザー名が指定されていません');

  const startDate = String(payload.startDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    throw new Error('開始日を正しく指定してください');
  }

  const messages = {
    25: sanitizeMessage_(payload.msg25),
    50: sanitizeMessage_(payload.msg50),
    75: sanitizeMessage_(payload.msg75),
    100: sanitizeMessage_(payload.msg100)
  };

  upsertChallenge_(userName, startDate, messages);

  return { status: 'success', data: { startDate: startDate, messages: messages } };
}

function sanitizeMessage_(text) {
  if (!text) return '';
  return String(text).trim().replace(/[\r\n\t]/g, ' ').substring(0, 60);
}

/**
 * 本日の「ひとこと」を保存する（1日1件、当日分は上書き）
 */
function handleDiaryPost_(payload) {
  const userName = sanitizeUserName_(payload.userName);
  if (!userName) throw new Error('ユーザー名が指定されていません');

  const text = sanitizeMessage_(payload.text);
  upsertDiaryToday_(userName, text);

  return { status: 'success', data: { text: text } };
}

/**
 * ==============================================================
 * ダッシュボード集計
 * ==============================================================
 */

function buildDashboard_(userName) {
  const profile = getProfile_(userName);
  const latestWeight = getLatestWeight_(userName);
  const todayMeals = getTodayMealRecords_(userName);
  const todayCalories = todayMeals.reduce(function (sum, r) { return sum + (Number(r.calories) || 0); }, 0);

  let bmr = null, tdee = null, balance = null, weeklyDelta = null;
  if (profile && latestWeight) {
    bmr = calcBmr_(profile.sex, profile.age, latestWeight.weightKg);
    const pal = palValue_(profile.age, profile.palLevel);
    tdee = Math.round(bmr * pal);
    balance = todayCalories - tdee;
    // ΔW = (C_in - BMR×PAL) / 7200 の週間換算（体脂肪1kgあたり約7200kcalとして計算）
    weeklyDelta = Math.round((balance * 7 / 7200) * 100) / 100;
  }

  const activeDays = getActiveDaysSet_(userName);
  const streakDays = calcStreak_(activeDays);
  const todayDiary = getTodayDiary_(userName);
  const challenge = buildChallengeInfo_(userName, activeDays);

  return {
    profile: profile,
    latestWeight: latestWeight,
    todayMeals: todayMeals,
    todayCalories: todayCalories,
    bmr: bmr,
    tdee: tdee,
    balance: balance,
    weeklyDelta: weeklyDelta,
    streakDays: streakDays,
    todayDiary: todayDiary,
    challenge: challenge
  };
}

function emptyDashboard_() {
  return {
    profile: null, latestWeight: null, todayMeals: [], todayCalories: 0,
    bmr: null, tdee: null, balance: null, weeklyDelta: null,
    streakDays: 0, todayDiary: '', challenge: null
  };
}

/**
 * ==============================================================
 * 基礎代謝・活動レベル 計算
 * ==============================================================
 */

function bmrPerKg_(age, sex) {
  const band = findBand_(BMR_TABLE, age);
  return sex === 'male' ? band.male : band.female;
}

function palValue_(age, level) {
  const band = findBand_(PAL_TABLE, age);
  return band[level] || band.normal;
}

function findBand_(table, age) {
  for (let i = 0; i < table.length; i++) {
    if (age >= table[i].min && age <= table[i].max) return table[i];
  }
  return age < table[0].min ? table[0] : table[table.length - 1];
}

function calcBmr_(sex, age, weightKg) {
  return Math.round(bmrPerKg_(age, sex) * weightKg);
}

/**
 * ==============================================================
 * プロフィール（性別・年齢・身長・活動レベル）
 * ==============================================================
 */

function getProfile_(userName) {
  const sheet = getOrCreateSheet_(PROFILE_SHEET_NAME, PROFILE_HEADER);
  if (sheet.getLastRow() < 2) return null;

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, PROFILE_HEADER.length).getValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i][0] === userName) {
      return {
        sex: values[i][1] === '男性' ? 'male' : 'female',
        age: Number(values[i][2]),
        heightCm: Number(values[i][3]),
        palLevel: labelToPalLevel_(values[i][4])
      };
    }
  }
  return null;
}

function upsertProfile_(userName, sex, age, heightCm, palLevel) {
  const sheet = getOrCreateSheet_(PROFILE_SHEET_NAME, PROFILE_HEADER);
  const sexLabel = sex === 'male' ? '男性' : '女性';
  const palLabel = palLevelToLabel_(palLevel);
  const now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');

  const rowIndex = findRowIndexByName_(sheet, userName);
  const rowData = [userName, sexLabel, age, heightCm, palLabel, now];

  if (rowIndex) {
    sheet.getRange(rowIndex, 1, 1, PROFILE_HEADER.length).setValues([rowData]);
  } else {
    sheet.appendRow(rowData);
  }
}

function palLevelToLabel_(level) {
  return level === 'low' ? '低い' : (level === 'high' ? '高い' : 'ふつう');
}

function labelToPalLevel_(label) {
  return label === '低い' ? 'low' : (label === '高い' ? 'high' : 'normal');
}

/**
 * ==============================================================
 * 体重記録（1日1件、当日分は上書き）
 * ==============================================================
 */

function getLatestWeight_(userName) {
  const sheet = getOrCreateSheet_(WEIGHT_SHEET_NAME, WEIGHT_HEADER);
  if (sheet.getLastRow() < 2) return null;

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, WEIGHT_HEADER.length).getValues();
  let latest = null;
  values.forEach(function (row) {
    if (row[0] === userName) {
      if (!latest || String(row[1]) > latest.date) {
        latest = { date: row[1], weightKg: Number(row[2]) };
      }
    }
  });
  return latest;
}

function upsertWeightToday_(userName, weightKg) {
  const sheet = getOrCreateSheet_(WEIGHT_SHEET_NAME, WEIGHT_HEADER);
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const nowTime = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'HH:mm:ss');

  if (sheet.getLastRow() >= 2) {
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
    for (let i = 0; i < values.length; i++) {
      if (values[i][0] === userName && values[i][1] === today) {
        sheet.getRange(i + 2, 3, 1, 2).setValues([[weightKg, nowTime]]);
        return;
      }
    }
  }
  sheet.appendRow([userName, today, weightKg, nowTime]);
}

function getWeightOnOrAfter_(userName, dateStr) {
  const sheet = getOrCreateSheet_(WEIGHT_SHEET_NAME, WEIGHT_HEADER);
  if (sheet.getLastRow() < 2) return null;

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, WEIGHT_HEADER.length).getValues();
  let earliest = null;
  values.forEach(function (row) {
    if (row[0] === userName && String(row[1]) >= dateStr) {
      if (!earliest || String(row[1]) < earliest.date) {
        earliest = { date: row[1], weightKg: Number(row[2]) };
      }
    }
  });
  return earliest;
}

/**
 * ==============================================================
 * 100日チャレンジ・ひとこと日記・継続日数
 * ==============================================================
 */

function getChallenge_(userName) {
  const sheet = getOrCreateSheet_(CHALLENGE_SHEET_NAME, CHALLENGE_HEADER);
  if (sheet.getLastRow() < 2) return null;

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, CHALLENGE_HEADER.length).getValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i][0] === userName) {
      return {
        startDate: values[i][1],
        messages: { 25: values[i][2] || '', 50: values[i][3] || '', 75: values[i][4] || '', 100: values[i][5] || '' }
      };
    }
  }
  return null;
}

function upsertChallenge_(userName, startDate, messages) {
  const sheet = getOrCreateSheet_(CHALLENGE_SHEET_NAME, CHALLENGE_HEADER);
  const now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  const rowData = [userName, startDate, messages[25], messages[50], messages[75], messages[100], now];

  const rowIndex = findRowIndexByName_(sheet, userName);
  if (rowIndex) {
    sheet.getRange(rowIndex, 1, 1, CHALLENGE_HEADER.length).setValues([rowData]);
  } else {
    sheet.appendRow(rowData);
  }
}

function buildChallengeInfo_(userName, activeDays) {
  const challenge = getChallenge_(userName);
  if (!challenge) return null;

  const today = todayStr_();
  const dayIndexRaw = daysBetween_(challenge.startDate, today) + 1;
  const dayIndex = Math.max(1, dayIndexRaw);
  const completed = dayIndexRaw > CHALLENGE_TOTAL_DAYS;
  const dayIndexClamped = Math.min(dayIndex, CHALLENGE_TOTAL_DAYS);
  const progressPercent = Math.min(100, Math.round((dayIndexClamped / CHALLENGE_TOTAL_DAYS) * 100));
  const loggedDays = countLoggedDaysInRange_(activeDays, challenge.startDate, today);

  const startWeight = getWeightOnOrAfter_(userName, challenge.startDate);
  const latestWeight = getLatestWeight_(userName);
  let weightDelta = null;
  if (startWeight && latestWeight) {
    weightDelta = Math.round((latestWeight.weightKg - startWeight.weightKg) * 10) / 10;
  }

  return {
    startDate: challenge.startDate,
    dayIndex: dayIndex,
    totalDays: CHALLENGE_TOTAL_DAYS,
    progressPercent: progressPercent,
    completed: completed,
    messages: challenge.messages,
    loggedDays: loggedDays,
    weightDelta: weightDelta
  };
}

function getTodayDiary_(userName) {
  const sheet = getOrCreateSheet_(DIARY_SHEET_NAME, DIARY_HEADER);
  if (sheet.getLastRow() < 2) return '';

  const today = todayStr_();
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, DIARY_HEADER.length).getValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i][0] === userName && values[i][1] === today) return values[i][2] || '';
  }
  return '';
}

function upsertDiaryToday_(userName, text) {
  const sheet = getOrCreateSheet_(DIARY_SHEET_NAME, DIARY_HEADER);
  const today = todayStr_();

  if (sheet.getLastRow() >= 2) {
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
    for (let i = 0; i < values.length; i++) {
      if (values[i][0] === userName && values[i][1] === today) {
        sheet.getRange(i + 2, 3, 1, 1).setValues([[text]]);
        return;
      }
    }
  }
  sheet.appendRow([userName, today, text]);
}

/**
 * ユーザーが何らかの記録（食事・体重・ひとこと）を行った日付の集合を返す。
 * 継続日数（ストリーク）と、チャレンジ期間中の記録日数の算出に使用する。
 */
function getActiveDaysSet_(userName) {
  const days = {};

  const mealSheet = getOrCreateSheet_(MEAL_SHEET_NAME, MEAL_HEADER);
  if (mealSheet.getLastRow() >= 2) {
    mealSheet.getRange(2, 1, mealSheet.getLastRow() - 1, 2).getValues().forEach(function (row) {
      if (row[0] === userName) days[row[1]] = true;
    });
  }

  const weightSheet = getOrCreateSheet_(WEIGHT_SHEET_NAME, WEIGHT_HEADER);
  if (weightSheet.getLastRow() >= 2) {
    weightSheet.getRange(2, 1, weightSheet.getLastRow() - 1, 2).getValues().forEach(function (row) {
      if (row[0] === userName) days[row[1]] = true;
    });
  }

  const diarySheet = getOrCreateSheet_(DIARY_SHEET_NAME, DIARY_HEADER);
  if (diarySheet.getLastRow() >= 2) {
    diarySheet.getRange(2, 1, diarySheet.getLastRow() - 1, 2).getValues().forEach(function (row) {
      if (row[0] === userName) days[row[1]] = true;
    });
  }

  return days;
}

/**
 * 直近の連続記録日数を計算する。
 * 今日まだ何も記録していなくても、昨日まで連続していればストリークは切らさない
 * （「今日はこれから記録する」ことを妨げないため）。
 */
function calcStreak_(activeDaysSet) {
  let streak = 0;
  let cursor = new Date();

  const todayKey = Utilities.formatDate(cursor, 'Asia/Tokyo', 'yyyy-MM-dd');
  if (!activeDaysSet[todayKey]) {
    cursor.setDate(cursor.getDate() - 1);
  }

  while (true) {
    const key = Utilities.formatDate(cursor, 'Asia/Tokyo', 'yyyy-MM-dd');
    if (activeDaysSet[key]) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

function countLoggedDaysInRange_(activeDaysSet, startStr, endStr) {
  let count = 0;
  Object.keys(activeDaysSet).forEach(function (dateStr) {
    if (dateStr >= startStr && dateStr <= endStr) count++;
  });
  return count;
}

function daysBetween_(startStr, endStr) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((parseDateOnly_(endStr) - parseDateOnly_(startStr)) / msPerDay);
}

function parseDateOnly_(dateStr) {
  const parts = String(dateStr).split('-').map(Number);
  return Date.UTC(parts[0], parts[1] - 1, parts[2]);
}

function todayStr_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
}

/**
 * ==============================================================
 * 食事記録（画像解析・追記・取得）
 * ==============================================================
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
    const blockReason = json.promptFeedback && json.promptFeedback.blockReason;
    throw new Error('Gemini APIから有効な応答が得られませんでした' + (blockReason ? '（理由: ' + blockReason + '）' : ''));
  }

  let parsed;
  try {
    parsed = JSON.parse(part.text);
  } catch (parseErr) {
    const match = part.text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AIの応答をJSONとして解析できませんでした');
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

function saveImageToDrive_(base64Image, mimeType, userName) {
  const folderId = PropertiesService.getScriptProperties().getProperty('DRIVE_FOLDER_ID');
  if (!folderId) return '';

  const folder = DriveApp.getFolderById(folderId);
  const decoded = Utilities.base64Decode(base64Image);
  const ext = mimeType.split('/')[1] || 'jpg';
  const safeName = (userName || 'unknown').replace(/[^\w\u3040-\u30FF\u4E00-\u9FFF-]/g, '_');
  const fileName = safeName + '_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss') + '.' + ext;
  const blob = Utilities.newBlob(decoded, mimeType, fileName);
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}

function appendMealRecord_(userName, analysis, imageUrl) {
  const sheet = getOrCreateSheet_(MEAL_SHEET_NAME, MEAL_HEADER);
  const now = new Date();

  sheet.appendRow([
    userName,
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

function getTodayMealRecords_(userName) {
  const sheet = getOrCreateSheet_(MEAL_SHEET_NAME, MEAL_HEADER);
  if (sheet.getLastRow() < 2) return [];

  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, MEAL_HEADER.length).getValues();

  return values
    .filter(function (row) { return row[0] === userName && row[1] === today; })
    .map(function (row) {
      return {
        name: row[0], date: row[1], time: row[2], foodName: row[3],
        calories: row[4], protein: row[5], fat: row[6], carbs: row[7],
        imageUrl: row[8], note: row[9]
      };
    })
    .reverse();
}

/**
 * ==============================================================
 * 共通ユーティリティ
 * ==============================================================
 */

function sanitizeUserName_(name) {
  if (!name) return '';
  const trimmed = String(name).trim().replace(/[\r\n\t]/g, '');
  return trimmed.substring(0, 20);
}

function findRowIndexByName_(sheet, userName) {
  if (sheet.getLastRow() < 2) return null;
  const names = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < names.length; i++) {
    if (names[i][0] === userName) return i + 2;
  }
  return null;
}

function getOrCreateSheet_(name, header) {
  const sheetId = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  const ss = sheetId ? SpreadsheetApp.openById(sheetId) : SpreadsheetApp.getActiveSpreadsheet();

  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(header);
    sheet.getRange(1, 1, 1, header.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * 動作確認用：スクリプトエディタから実行してAPIキー疎通を確認する
 */
function testGeminiConnection() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  Logger.log(apiKey ? 'GEMINI_API_KEY は設定されています（' + apiKey.substring(0, 4) + '...）' : 'GEMINI_API_KEY が未設定です');
}
