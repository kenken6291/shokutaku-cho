/**
 * ==============================================================
 * 食卓帳 - GAS バックエンド（メール認証・歩数記録版）
 * ==============================================================
 *
 * 【できること】
 *   1. メールアドレス登録 → 仮パスワードをメール送信 → 初回ログイン時にパスワード変更必須
 *   2. 表示用ニックネーム（登録後も変更可能）、利用規約・免責事項への同意
 *   3. 食事写真からAIでカロリー・PFCを解析してスプレッドシートに記録
 *   4. からだプロフィール（性別・年齢・身長・活動レベル）、体重記録、基礎代謝(BMR)算出
 *   5. 歩数記録 → 歩数から消費カロリーを概算し、体重記録がある日はBMR+歩数消費、
 *      無い日はBMR×活動レベル(PAL)で「本日の消費カロリー合計」を算出
 *   6. 「100日チャレンジ」：進捗・継続記録日数・連続記録日数を育つキャラクターと共に表示
 *   7. 食事・体重・歩数の履歴一覧表示、日付・時刻を含めて修正・削除
 *   8. アカウント設定（ニックネーム変更・パスワード変更・アカウント削除）
 *
 * 【事前設定】スクリプトプロパティ（プロジェクトの設定 > スクリプト プロパティ）
 *   GEMINI_API_KEY  : Google AI Studio で発行したGemini APIキー（必須）
 *   SHEET_ID        : 記録先スプレッドシートのID（未設定ならバインド先スプレッドシートを使用）
 *   DRIVE_FOLDER_ID : 食事写真を保存するGoogle DriveフォルダID（任意）
 *   PASSWORD_PEPPER : パスワードハッシュ化に使う秘密文字列（必須）
 *
 * 【Webアプリのデプロイ設定】
 *   実行するユーザー: 自分（スクリプト所有者）
 *   アクセスできるユーザー: 全員（匿名ユーザーを含む）
 *
 * 【重要】日付・時刻列は必ずプレーンテキスト書式で保存する。
 * Googleスプレッドシートは「2026-07-08」のような文字列を書き込むと自動的に日付型セルに
 * 変換してしまい、後で読み取ると全く別のDateオブジェクト（UTC変換された値）になって返ってくる。
 * この不具合を修正するため、日付・時刻列は sheet.setNumberFormat('@') でプレーンテキスト化した上で
 * 文字列を書き込んでいる。既存データが既に壊れている場合は repairDateFormatting() を
 * スクリプトエディタから一度手動実行することで修復できる。
 * ==============================================================
 */

const MEAL_SHEET_NAME = '摂取カロリー記録';
const PROFILE_SHEET_NAME = 'プロフィール';
const WEIGHT_SHEET_NAME = '体重記録';
const STEPS_SHEET_NAME = '歩数記録';
const USER_SHEET_NAME = 'ユーザー';
const CHALLENGE_SHEET_NAME = 'チャレンジ';
const DIARY_SHEET_NAME = 'ひとこと日記';
const GEMINI_MODEL = 'gemini-3.5-flash'; // 現行の安定版フラッグシップモデル（2026年7月時点）
const CHALLENGE_TOTAL_DAYS = 100;
const MIN_PASSWORD_LENGTH = 8;
const STEPS_KCAL_PER_KG_PER_STEP = 0.0005; // 歩数消費カロリーの係数（下記 calcStepsCalories_ 参照）

const MEAL_HEADER = ['ID', 'メールアドレス', '日付', '時刻', '料理名', 'カロリー(kcal)', 'たんぱく質(g)', '脂質(g)', '炭水化物(g)', '画像URL', '備考'];
const PROFILE_HEADER = ['メールアドレス', '性別', '年齢', '身長(cm)', '活動レベル', '更新日時'];
const WEIGHT_HEADER = ['ID', 'メールアドレス', '日付', '体重(kg)', '登録時刻'];
const STEPS_HEADER = ['ID', 'メールアドレス', '日付', '歩数', '消費カロリー(kcal)', '登録時刻'];
const USER_HEADER = ['メールアドレス', 'パスワードハッシュ', 'ソルト', 'ニックネーム', '仮パスワード', 'セッショントークン', '規約同意日時', '登録日時', '更新日時'];
const CHALLENGE_HEADER = ['メールアドレス', '開始日', 'メッセージ25', 'メッセージ50', 'メッセージ75', 'メッセージ100', '更新日時'];
const DIARY_HEADER = ['メールアドレス', '日付', 'ひとこと'];

/**
 * 日付・時刻・日時を含む列のプレーンテキスト化対象（1始まりの列番号）。
 * getOrCreateSheet_ での新規作成時、および repairDateFormatting() での一括修復に使用する。
 */
const DATE_TIME_COLUMN_CONFIG = {};
DATE_TIME_COLUMN_CONFIG[MEAL_SHEET_NAME] = { date: [3], time: [4], datetime: [] };
DATE_TIME_COLUMN_CONFIG[WEIGHT_SHEET_NAME] = { date: [3], time: [5], datetime: [] };
DATE_TIME_COLUMN_CONFIG[STEPS_SHEET_NAME] = { date: [3], time: [6], datetime: [] };
DATE_TIME_COLUMN_CONFIG[CHALLENGE_SHEET_NAME] = { date: [2], time: [], datetime: [7] };
DATE_TIME_COLUMN_CONFIG[DIARY_SHEET_NAME] = { date: [2], time: [], datetime: [] };
DATE_TIME_COLUMN_CONFIG[USER_SHEET_NAME] = { date: [], time: [], datetime: [7, 8, 9] };
DATE_TIME_COLUMN_CONFIG[PROFILE_SHEET_NAME] = { date: [], time: [], datetime: [6] };

const HEADER_BY_SHEET_ = {};
HEADER_BY_SHEET_[MEAL_SHEET_NAME] = MEAL_HEADER;
HEADER_BY_SHEET_[WEIGHT_SHEET_NAME] = WEIGHT_HEADER;
HEADER_BY_SHEET_[STEPS_SHEET_NAME] = STEPS_HEADER;
HEADER_BY_SHEET_[CHALLENGE_SHEET_NAME] = CHALLENGE_HEADER;
HEADER_BY_SHEET_[DIARY_SHEET_NAME] = DIARY_HEADER;
HEADER_BY_SHEET_[USER_SHEET_NAME] = USER_HEADER;
HEADER_BY_SHEET_[PROFILE_SHEET_NAME] = PROFILE_HEADER;

/**
 * 基礎代謝基準値（kcal/kg体重/日） 出典: 厚生労働省「日本人の食事摂取基準（2020年版）」
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
 * 身体活動レベル（低い/ふつう/高い） 出典: 厚生労働省「日本人の食事摂取基準（2020年版）」
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

function doPost(e) {
  const output = ContentService.createTextOutput().setMimeType(ContentService.MimeType.JSON);

  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error('リクエストボディが空です');
    }
    const payload = JSON.parse(e.postData.contents);
    let result;

    switch (payload.type) {
      case 'signup': result = handleSignupPost_(payload); break;
      case 'login': result = handleLoginPost_(payload); break;
      case 'changePassword': result = handleChangePasswordPost_(payload); break;
      case 'updateNickname': result = handleUpdateNicknamePost_(payload); break;
      case 'deleteAccount': result = handleDeleteAccountPost_(payload); break;
      case 'logout': result = handleLogoutPost_(payload); break;
      case 'meal': result = handleMealPost_(payload); break;
      case 'profile': result = handleProfilePost_(payload); break;
      case 'weight': result = handleWeightPost_(payload); break;
      case 'steps': result = handleStepsPost_(payload); break;
      case 'challenge': result = handleChallengePost_(payload); break;
      case 'diary': result = handleDiaryPost_(payload); break;
      case 'updateMeal': result = handleUpdateMealPost_(payload); break;
      case 'deleteMeal': result = handleDeleteMealPost_(payload); break;
      case 'updateWeight': result = handleUpdateWeightPost_(payload); break;
      case 'deleteWeight': result = handleDeleteWeightPost_(payload); break;
      case 'updateSteps': result = handleUpdateStepsPost_(payload); break;
      case 'deleteSteps': result = handleDeleteStepsPost_(payload); break;
      default: throw new Error('不明なリクエスト種別です: ' + payload.type);
    }

    output.setContent(JSON.stringify(result));
  } catch (err) {
    output.setContent(JSON.stringify({ status: 'error', message: err.message }));
  }

  return output;
}

/**
 * データ取得。クエリパラメータ:
 *   ?token=セッショントークン&action=dashboard  … 本日のダッシュボード（既定）
 *   ?token=セッショントークン&action=history    … 食事・体重・歩数の全履歴
 */
function doGet(e) {
  const output = ContentService.createTextOutput().setMimeType(ContentService.MimeType.JSON);

  try {
    const token = e && e.parameter && e.parameter.token;
    const action = (e && e.parameter && e.parameter.action) || 'dashboard';

    if (!token) {
      const empty = action === 'history' ? { meals: [], weights: [], steps: [] } : emptyDashboard_();
      output.setContent(JSON.stringify({ status: 'success', data: empty }));
      return output;
    }

    const session = resolveSession_(token);
    let data;
    if (action === 'history') {
      data = buildHistory_(session.email);
    } else {
      data = buildDashboard_(session.email);
      data.nickname = session.nickname;
    }

    output.setContent(JSON.stringify({ status: 'success', data: data }));
  } catch (err) {
    output.setContent(JSON.stringify({ status: 'error', message: err.message }));
  }

  return output;
}

/**
 * ==============================================================
 * 認証（登録・ログイン・パスワード変更・ニックネーム変更・アカウント削除）
 * ==============================================================
 */

function handleSignupPost_(payload) {
  const email = sanitizeEmail_(payload.email);
  if (!isValidEmail_(email)) throw new Error('メールアドレスの形式が正しくありません');

  const nickname = sanitizeNickname_(payload.nickname);
  if (!nickname) throw new Error('ニックネームを入力してください');

  if (payload.agreeTerms !== true) throw new Error('利用規約・免責事項へのご同意が必要です');

  const sheet = getOrCreateSheet_(USER_SHEET_NAME, USER_HEADER);
  if (findRowIndexByKey_(sheet, email)) {
    throw new Error('このメールアドレスは既に登録されています');
  }
  if (isNicknameTakenByOther_(nickname, null)) {
    throw new Error('そのニックネームは既に使われています。別の名前をお試しください。');
  }

  const tempPassword = generateTempPassword_();
  const salt = generateSalt_();
  const hash = hashPassword_(tempPassword, salt);
  const now = nowStr_();

  sheet.appendRow([email, hash, salt, nickname, 'TRUE', '', now, now, now]);

  try {
    sendTempPasswordEmail_(email, tempPassword);
  } catch (mailErr) {
    const rowIndex = findRowIndexByKey_(sheet, email);
    if (rowIndex) sheet.deleteRow(rowIndex);
    throw new Error('確認メールの送信に失敗しました。しばらくしてから再度お試しください。');
  }

  return { status: 'success', data: { email: email } };
}

function handleLoginPost_(payload) {
  const email = sanitizeEmail_(payload.email);
  const password = String(payload.password || '');
  if (!email || !password) throw new Error('メールアドレスとパスワードを入力してください');

  const sheet = getOrCreateSheet_(USER_SHEET_NAME, USER_HEADER);
  const rowIndex = findRowIndexByKey_(sheet, email);
  if (!rowIndex) throw new Error('メールアドレスまたはパスワードが正しくありません');

  const row = sheet.getRange(rowIndex, 1, 1, USER_HEADER.length).getValues()[0];
  const storedHash = row[1], salt = row[2], nickname = row[3], mustChange = row[4] === 'TRUE';

  if (hashPassword_(password, salt) !== storedHash) {
    throw new Error('メールアドレスまたはパスワードが正しくありません');
  }

  if (mustChange) {
    return { status: 'success', data: { requirePasswordChange: true, email: email } };
  }

  const token = generateToken_();
  sheet.getRange(rowIndex, 6, 1, 1).setValue(token);
  sheet.getRange(rowIndex, 9, 1, 1).setValue(nowStr_());

  return { status: 'success', data: { token: token, nickname: nickname, email: email } };
}

function handleChangePasswordPost_(payload) {
  const newPassword = String(payload.newPassword || '');
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error('新しいパスワードは' + MIN_PASSWORD_LENGTH + '文字以上で入力してください');
  }

  const sheet = getOrCreateSheet_(USER_SHEET_NAME, USER_HEADER);
  let rowIndex, email;

  if (payload.token) {
    const session = resolveSession_(payload.token);
    rowIndex = session.rowIndex;
    email = session.email;
  } else {
    email = sanitizeEmail_(payload.email);
    rowIndex = findRowIndexByKey_(sheet, email);
  }
  if (!rowIndex) throw new Error('現在のパスワードが正しくありません');

  const row = sheet.getRange(rowIndex, 1, 1, USER_HEADER.length).getValues()[0];
  const currentPassword = String(payload.currentPassword || '');
  if (hashPassword_(currentPassword, row[2]) !== row[1]) {
    throw new Error('現在のパスワードが正しくありません');
  }

  const newSalt = generateSalt_();
  const newHash = hashPassword_(newPassword, newSalt);
  const newToken = generateToken_();
  const now = nowStr_();

  sheet.getRange(rowIndex, 2, 1, 1).setValue(newHash);
  sheet.getRange(rowIndex, 3, 1, 1).setValue(newSalt);
  sheet.getRange(rowIndex, 5, 1, 1).setValue('FALSE');
  sheet.getRange(rowIndex, 6, 1, 1).setValue(newToken);
  sheet.getRange(rowIndex, 9, 1, 1).setValue(now);

  const nickname = row[3];
  return { status: 'success', data: { token: newToken, nickname: nickname, email: email } };
}

function handleUpdateNicknamePost_(payload) {
  const session = resolveSession_(payload.token);
  const nickname = sanitizeNickname_(payload.nickname);
  if (!nickname) throw new Error('ニックネームを入力してください');

  if (isNicknameTakenByOther_(nickname, session.email)) {
    throw new Error('そのニックネームは既に使われています。別の名前をお試しください。');
  }

  const sheet = getOrCreateSheet_(USER_SHEET_NAME, USER_HEADER);
  sheet.getRange(session.rowIndex, 4, 1, 1).setValue(nickname);
  sheet.getRange(session.rowIndex, 9, 1, 1).setValue(nowStr_());

  return { status: 'success', data: { nickname: nickname } };
}

function handleDeleteAccountPost_(payload) {
  const session = resolveSession_(payload.token);
  const sheet = getOrCreateSheet_(USER_SHEET_NAME, USER_HEADER);
  sheet.deleteRow(session.rowIndex);
  return { status: 'success', data: {} };
}

function handleLogoutPost_(payload) {
  try {
    const session = resolveSession_(payload.token);
    const sheet = getOrCreateSheet_(USER_SHEET_NAME, USER_HEADER);
    sheet.getRange(session.rowIndex, 6, 1, 1).setValue('');
  } catch (err) {
    // トークンが既に無効でもエラーにはしない
  }
  return { status: 'success', data: {} };
}

function resolveSession_(token) {
  if (!token) throw new Error('ログインが必要です');
  const sheet = getOrCreateSheet_(USER_SHEET_NAME, USER_HEADER);
  if (sheet.getLastRow() < 2) throw new Error('セッションが無効です。再度ログインしてください');

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, USER_HEADER.length).getValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i][5] && values[i][5] === token) {
      return { rowIndex: i + 2, email: values[i][0], nickname: values[i][3] };
    }
  }
  throw new Error('セッションが無効です。再度ログインしてください');
}

function isNicknameTakenByOther_(nickname, excludeEmail) {
  const sheet = getOrCreateSheet_(USER_SHEET_NAME, USER_HEADER);
  if (sheet.getLastRow() < 2) return false;

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, USER_HEADER.length).getValues();
  const normalized = nickname.toLowerCase();
  return values.some(function (row) {
    if (excludeEmail && row[0] === excludeEmail) return false;
    return String(row[3] || '').toLowerCase() === normalized;
  });
}

/**
 * ==============================================================
 * パスワード・トークン ユーティリティ
 * ==============================================================
 */

function getPasswordPepper_() {
  const pepper = PropertiesService.getScriptProperties().getProperty('PASSWORD_PEPPER');
  if (!pepper) throw new Error('スクリプトプロパティに PASSWORD_PEPPER が設定されていません');
  return pepper;
}

function hashPassword_(password, salt) {
  const pepper = getPasswordPepper_();
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password + ':' + salt + ':' + pepper);
  return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function generateSalt_() {
  return Utilities.getUuid();
}

function generateToken_() {
  return Utilities.getUuid() + Utilities.getUuid();
}

function generateTempPassword_() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let pw = '';
  for (let i = 0; i < 10; i++) {
    pw += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pw;
}

function sendTempPasswordEmail_(email, tempPassword) {
  const subject = '【食卓帳】仮パスワードのお知らせ';
  const body =
    '食卓帳にご登録いただきありがとうございます。\n\n' +
    '以下の仮パスワードでログインしてください。ログイン後、新しいパスワードの設定をお願いします。\n\n' +
    '仮パスワード: ' + tempPassword + '\n\n' +
    'このメールに心当たりがない場合は、このメールを破棄していただいて問題ありません。';
  MailApp.sendEmail(email, subject, body);
}

function sanitizeEmail_(email) {
  if (!email) return '';
  return String(email).trim().toLowerCase().substring(0, 100);
}

function isValidEmail_(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function sanitizeNickname_(name) {
  if (!name) return '';
  const trimmed = String(name).trim().replace(/[\r\n\t]/g, '');
  return trimmed.substring(0, 20);
}

/**
 * ==============================================================
 * POSTハンドラ（記録系：食事・からだ・体重・歩数・チャレンジ・ひとこと）
 * ==============================================================
 */

function handleMealPost_(payload) {
  const session = resolveSession_(payload.token);
  const email = session.email;

  const base64Image = payload.image;
  const mimeType = payload.mimeType || 'image/jpeg';

  if (!base64Image) throw new Error('画像データが送信されていません');
  if (['image/jpeg', 'image/png', 'image/webp', 'image/heic'].indexOf(mimeType) === -1) {
    throw new Error('対応していない画像形式です: ' + mimeType);
  }

  const analysis = analyzeFoodImage_(base64Image, mimeType);

  let imageUrl = '';
  try {
    imageUrl = saveImageToDrive_(base64Image, mimeType, email);
  } catch (driveErr) {
    console.warn('Driveへの画像保存に失敗しました: ' + driveErr.message);
  }

  const id = appendMealRecord_(email, analysis, imageUrl);

  return { status: 'success', data: analysis, imageUrl: imageUrl, id: id };
}

function handleProfilePost_(payload) {
  const session = resolveSession_(payload.token);

  const sex = payload.sex === 'male' ? 'male' : (payload.sex === 'female' ? 'female' : null);
  const age = Math.round(Number(payload.age));
  const heightCm = Math.round(Number(payload.heightCm) * 10) / 10;
  const palLevel = ['low', 'normal', 'high'].indexOf(payload.palLevel) !== -1 ? payload.palLevel : 'normal';

  if (!sex) throw new Error('性別を選択してください');
  if (!age || age < 1 || age > 120) throw new Error('年齢を正しく入力してください（1〜120）');
  if (!heightCm || heightCm < 50 || heightCm > 250) throw new Error('身長を正しく入力してください（50〜250cm）');

  upsertProfile_(session.email, sex, age, heightCm, palLevel);

  return { status: 'success', data: { sex: sex, age: age, heightCm: heightCm, palLevel: palLevel } };
}

function handleWeightPost_(payload) {
  const session = resolveSession_(payload.token);

  const weightKg = Math.round(Number(payload.weightKg) * 10) / 10;
  if (!weightKg || weightKg < 20 || weightKg > 300) throw new Error('体重を正しく入力してください（20〜300kg）');

  const id = upsertWeightToday_(session.email, weightKg);

  return { status: 'success', data: { weightKg: weightKg, id: id } };
}

function handleStepsPost_(payload) {
  const session = resolveSession_(payload.token);

  const steps = Math.round(Number(payload.steps));
  if (!steps || steps < 0 || steps > 100000) throw new Error('歩数を正しく入力してください（0〜100,000歩）');

  const result = upsertStepsToday_(session.email, steps);

  return { status: 'success', data: { steps: steps, caloriesBurned: result.caloriesBurned, id: result.id } };
}

function handleChallengePost_(payload) {
  const session = resolveSession_(payload.token);

  const startDate = String(payload.startDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new Error('開始日を正しく指定してください');

  const messages = {
    25: sanitizeMessage_(payload.msg25),
    50: sanitizeMessage_(payload.msg50),
    75: sanitizeMessage_(payload.msg75),
    100: sanitizeMessage_(payload.msg100)
  };

  upsertChallenge_(session.email, startDate, messages);

  return { status: 'success', data: { startDate: startDate, messages: messages } };
}

function handleDiaryPost_(payload) {
  const session = resolveSession_(payload.token);
  const text = sanitizeMessage_(payload.text);
  upsertDiaryToday_(session.email, text);
  return { status: 'success', data: { text: text } };
}

function sanitizeMessage_(text) {
  if (!text) return '';
  return String(text).trim().replace(/[\r\n\t]/g, ' ').substring(0, 60);
}

/**
 * ==============================================================
 * 履歴の修正・削除（食事・体重・歩数）
 * ==============================================================
 */

function handleUpdateMealPost_(payload) {
  const session = resolveSession_(payload.token);
  const id = String(payload.id || '');
  if (!id) throw new Error('対象のIDが指定されていません');

  const sheet = getOrCreateSheet_(MEAL_SHEET_NAME, MEAL_HEADER);
  const rowIndex = findRowIndexByIdAndEmail_(sheet, id, session.email, 0, 1);
  if (!rowIndex) throw new Error('対象の記録が見つかりませんでした');

  const date = String(payload.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日付を正しく指定してください');
  const time = normalizeTimeInput_(payload.time);

  const foodName = String(payload.foodName || '').trim().substring(0, 40);
  const calories = Math.round(Number(payload.calories) || 0);
  const protein = roundTo1_(payload.protein);
  const fat = roundTo1_(payload.fat);
  const carbs = roundTo1_(payload.carbs);

  if (!foodName) throw new Error('料理名を入力してください');
  if (calories < 0 || calories > 5000) throw new Error('カロリーを正しく入力してください（0〜5000kcal）');

  sheet.getRange(rowIndex, 3, 1, 7).setValues([[date, time, foodName, calories, protein, fat, carbs]]);

  return { status: 'success', data: { id: id, date: date, time: time } };
}

function handleDeleteMealPost_(payload) {
  const session = resolveSession_(payload.token);
  const id = String(payload.id || '');
  if (!id) throw new Error('対象のIDが指定されていません');

  const sheet = getOrCreateSheet_(MEAL_SHEET_NAME, MEAL_HEADER);
  const rowIndex = findRowIndexByIdAndEmail_(sheet, id, session.email, 0, 1);
  if (!rowIndex) throw new Error('対象の記録が見つかりませんでした');

  sheet.deleteRow(rowIndex);
  return { status: 'success', data: { id: id } };
}

function handleUpdateWeightPost_(payload) {
  const session = resolveSession_(payload.token);
  const id = String(payload.id || '');
  if (!id) throw new Error('対象のIDが指定されていません');

  const sheet = getOrCreateSheet_(WEIGHT_SHEET_NAME, WEIGHT_HEADER);
  const rowIndex = findRowIndexByIdAndEmail_(sheet, id, session.email, 0, 1);
  if (!rowIndex) throw new Error('対象の記録が見つかりませんでした');

  const date = String(payload.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日付を正しく指定してください');

  const weightKg = Math.round(Number(payload.weightKg) * 10) / 10;
  if (!weightKg || weightKg < 20 || weightKg > 300) throw new Error('体重を正しく入力してください（20〜300kg）');

  if (isDateTakenByOtherRow_(sheet, session.email, date, rowIndex, 2)) {
    throw new Error('その日付には既に別の体重記録があります。日付を変更する場合は、先にその日の記録を削除してください。');
  }

  sheet.getRange(rowIndex, 3, 1, 2).setValues([[date, weightKg]]);
  return { status: 'success', data: { id: id, date: date, weightKg: weightKg } };
}

function handleDeleteWeightPost_(payload) {
  const session = resolveSession_(payload.token);
  const id = String(payload.id || '');
  if (!id) throw new Error('対象のIDが指定されていません');

  const sheet = getOrCreateSheet_(WEIGHT_SHEET_NAME, WEIGHT_HEADER);
  const rowIndex = findRowIndexByIdAndEmail_(sheet, id, session.email, 0, 1);
  if (!rowIndex) throw new Error('対象の記録が見つかりませんでした');

  sheet.deleteRow(rowIndex);
  return { status: 'success', data: { id: id } };
}

function handleUpdateStepsPost_(payload) {
  const session = resolveSession_(payload.token);
  const id = String(payload.id || '');
  if (!id) throw new Error('対象のIDが指定されていません');

  const sheet = getOrCreateSheet_(STEPS_SHEET_NAME, STEPS_HEADER);
  const rowIndex = findRowIndexByIdAndEmail_(sheet, id, session.email, 0, 1);
  if (!rowIndex) throw new Error('対象の記録が見つかりませんでした');

  const date = String(payload.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日付を正しく指定してください');

  const steps = Math.round(Number(payload.steps));
  if (!steps || steps < 0 || steps > 100000) throw new Error('歩数を正しく入力してください（0〜100,000歩）');

  if (isDateTakenByOtherRow_(sheet, session.email, date, rowIndex, 2)) {
    throw new Error('その日付には既に別の歩数記録があります。日付を変更する場合は、先にその日の記録を削除してください。');
  }

  const latestWeight = getLatestWeight_(session.email);
  const caloriesBurned = latestWeight ? calcStepsCalories_(latestWeight.weightKg, steps) : 0;

  sheet.getRange(rowIndex, 3, 1, 2).setValues([[date, steps]]);
  sheet.getRange(rowIndex, 5, 1, 1).setValue(caloriesBurned);

  return { status: 'success', data: { id: id, date: date, steps: steps, caloriesBurned: caloriesBurned } };
}

function handleDeleteStepsPost_(payload) {
  const session = resolveSession_(payload.token);
  const id = String(payload.id || '');
  if (!id) throw new Error('対象のIDが指定されていません');

  const sheet = getOrCreateSheet_(STEPS_SHEET_NAME, STEPS_HEADER);
  const rowIndex = findRowIndexByIdAndEmail_(sheet, id, session.email, 0, 1);
  if (!rowIndex) throw new Error('対象の記録が見つかりませんでした');

  sheet.deleteRow(rowIndex);
  return { status: 'success', data: { id: id } };
}

/**
 * 指定した日付が、同じユーザーの他の行に既に存在するかを調べる（体重・歩数は1日1件のため）。
 * dateColIdx は0始まりの列インデックス。
 */
function isDateTakenByOtherRow_(sheet, email, dateStr, excludeRowIndex, dateColIdx) {
  if (sheet.getLastRow() < 2) return false;
  const numCols = Math.max(dateColIdx, 1) + 1;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, numCols).getValues();
  for (let i = 0; i < values.length; i++) {
    const rowIndex = i + 2;
    if (rowIndex === excludeRowIndex) continue;
    if (values[i][1] === email && normalizeDateValue_(values[i][dateColIdx]) === dateStr) return true;
  }
  return false;
}

function findRowIndexByIdAndEmail_(sheet, id, email, idColIdx, emailColIdx) {
  if (sheet.getLastRow() < 2) return null;
  const numCols = Math.max(idColIdx, emailColIdx) + 1;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, numCols).getValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i][idColIdx] === id && values[i][emailColIdx] === email) return i + 2;
  }
  return null;
}

/**
 * ==============================================================
 * ダッシュボード・履歴 集計
 * ==============================================================
 */

function buildDashboard_(email) {
  const profile = getProfile_(email);
  const latestWeight = getLatestWeight_(email);
  const todayMeals = getTodayMealRecords_(email);
  const todayCalories = todayMeals.reduce(function (sum, r) { return sum + (Number(r.calories) || 0); }, 0);
  const todaySteps = getTodaySteps_(email);

  let bmr = null, tdee = null, tdeeSource = null, balance = null, weeklyDelta = null;
  if (profile && latestWeight) {
    bmr = calcBmr_(profile.sex, profile.age, latestWeight.weightKg);

    if (todaySteps) {
      // 歩数の実測値がある日はBMR＋歩数消費で算出（PALによる推定より精度が高い）
      tdee = bmr + todaySteps.caloriesBurned;
      tdeeSource = 'steps';
    } else {
      const pal = palValue_(profile.age, profile.palLevel);
      tdee = Math.round(bmr * pal);
      tdeeSource = 'pal';
    }

    balance = todayCalories - tdee;
    weeklyDelta = Math.round((balance * 7 / 7200) * 100) / 100;
  }

  const activeDays = getActiveDaysSet_(email);
  const streakDays = calcStreak_(activeDays);
  const todayDiary = getTodayDiary_(email);
  const challenge = buildChallengeInfo_(email, activeDays);

  return {
    profile: profile, latestWeight: latestWeight, todayMeals: todayMeals, todayCalories: todayCalories,
    todaySteps: todaySteps, bmr: bmr, tdee: tdee, tdeeSource: tdeeSource, balance: balance, weeklyDelta: weeklyDelta,
    streakDays: streakDays, todayDiary: todayDiary, challenge: challenge
  };
}

function emptyDashboard_() {
  return {
    profile: null, latestWeight: null, todayMeals: [], todayCalories: 0, todaySteps: null,
    bmr: null, tdee: null, tdeeSource: null, balance: null, weeklyDelta: null,
    streakDays: 0, todayDiary: '', challenge: null
  };
}

function buildHistory_(email) {
  const mealSheet = getOrCreateSheet_(MEAL_SHEET_NAME, MEAL_HEADER);
  let meals = [];
  if (mealSheet.getLastRow() >= 2) {
    const values = mealSheet.getRange(2, 1, mealSheet.getLastRow() - 1, MEAL_HEADER.length).getValues();
    meals = values
      .filter(function (row) { return row[1] === email; })
      .map(function (row) {
        const date = normalizeDateValue_(row[2]), time = normalizeTimeValue_(row[3]);
        return {
          id: row[0], date: date, time: time, foodName: row[4], calories: row[5],
          protein: row[6], fat: row[7], carbs: row[8], imageUrl: row[9], note: row[10]
        };
      })
      .sort(function (a, b) { return (b.date + b.time).localeCompare(a.date + a.time); })
      .slice(0, 200);
  }

  const weightSheet = getOrCreateSheet_(WEIGHT_SHEET_NAME, WEIGHT_HEADER);
  let weights = [];
  if (weightSheet.getLastRow() >= 2) {
    const values = weightSheet.getRange(2, 1, weightSheet.getLastRow() - 1, WEIGHT_HEADER.length).getValues();
    weights = values
      .filter(function (row) { return row[1] === email; })
      .map(function (row) {
        return { id: row[0], date: normalizeDateValue_(row[2]), weightKg: row[3] };
      })
      .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); })
      .slice(0, 200);
  }

  const stepsSheet = getOrCreateSheet_(STEPS_SHEET_NAME, STEPS_HEADER);
  let steps = [];
  if (stepsSheet.getLastRow() >= 2) {
    const values = stepsSheet.getRange(2, 1, stepsSheet.getLastRow() - 1, STEPS_HEADER.length).getValues();
    steps = values
      .filter(function (row) { return row[1] === email; })
      .map(function (row) {
        return { id: row[0], date: normalizeDateValue_(row[2]), steps: row[3], caloriesBurned: row[4] };
      })
      .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); })
      .slice(0, 200);
  }

  return { meals: meals, weights: weights, steps: steps };
}

/**
 * ==============================================================
 * 基礎代謝・活動レベル・歩数消費カロリー 計算
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
 * 歩数から消費カロリーを概算する。
 * 消費カロリー(kcal) ≈ 体重(kg) × 歩数 × 0.0005
 *
 * 根拠: 一般的な運動消費カロリーの計算式「METs×体重(kg)×時間(h)×1.05」に、
 * 普通歩行(3.0METs)・歩行ケイデンス約100歩/分という仮定を当てはめると
 * 時間(h)=歩数/100/60 となり、係数は 3.0×1.05/6000 ≈ 0.000525。
 * 体重60kg・1万歩で約300〜315kcalとなり、厚生労働省のメッツ表に基づく
 * 一般的な目安（体重60kgで1万歩=約300〜350kcal）とおおむね一致する。
 */
function calcStepsCalories_(weightKg, steps) {
  return Math.round(weightKg * steps * STEPS_KCAL_PER_KG_PER_STEP);
}

/**
 * ==============================================================
 * プロフィール（性別・年齢・身長・活動レベル）
 * ==============================================================
 */

function getProfile_(email) {
  const sheet = getOrCreateSheet_(PROFILE_SHEET_NAME, PROFILE_HEADER);
  if (sheet.getLastRow() < 2) return null;

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, PROFILE_HEADER.length).getValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i][0] === email) {
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

function upsertProfile_(email, sex, age, heightCm, palLevel) {
  const sheet = getOrCreateSheet_(PROFILE_SHEET_NAME, PROFILE_HEADER);
  const sexLabel = sex === 'male' ? '男性' : '女性';
  const palLabel = palLevelToLabel_(palLevel);
  const now = nowStr_();

  const rowIndex = findRowIndexByKey_(sheet, email);
  const rowData = [email, sexLabel, age, heightCm, palLabel, now];

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

function getLatestWeight_(email) {
  const sheet = getOrCreateSheet_(WEIGHT_SHEET_NAME, WEIGHT_HEADER);
  if (sheet.getLastRow() < 2) return null;

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, WEIGHT_HEADER.length).getValues();
  let latest = null;
  values.forEach(function (row) {
    if (row[1] === email) {
      const d = normalizeDateValue_(row[2]);
      if (!latest || d > latest.date) {
        latest = { id: row[0], date: d, weightKg: Number(row[3]) };
      }
    }
  });
  return latest;
}

function upsertWeightToday_(email, weightKg) {
  const sheet = getOrCreateSheet_(WEIGHT_SHEET_NAME, WEIGHT_HEADER);
  const today = todayStr_();
  const nowTime = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'HH:mm:ss');

  if (sheet.getLastRow() >= 2) {
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
    for (let i = 0; i < values.length; i++) {
      if (values[i][1] === email && normalizeDateValue_(values[i][2]) === today) {
        sheet.getRange(i + 2, 4, 1, 2).setValues([[weightKg, nowTime]]);
        return values[i][0];
      }
    }
  }
  const id = Utilities.getUuid();
  sheet.appendRow([id, email, today, weightKg, nowTime]);
  return id;
}

function getWeightOnOrAfter_(email, dateStr) {
  const sheet = getOrCreateSheet_(WEIGHT_SHEET_NAME, WEIGHT_HEADER);
  if (sheet.getLastRow() < 2) return null;

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, WEIGHT_HEADER.length).getValues();
  let earliest = null;
  values.forEach(function (row) {
    const d = normalizeDateValue_(row[2]);
    if (row[1] === email && d >= dateStr) {
      if (!earliest || d < earliest.date) {
        earliest = { id: row[0], date: d, weightKg: Number(row[3]) };
      }
    }
  });
  return earliest;
}

/**
 * ==============================================================
 * 歩数記録（1日1件、当日分は上書き）
 * ==============================================================
 */

function getTodaySteps_(email) {
  const sheet = getOrCreateSheet_(STEPS_SHEET_NAME, STEPS_HEADER);
  if (sheet.getLastRow() < 2) return null;

  const today = todayStr_();
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, STEPS_HEADER.length).getValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i][1] === email && normalizeDateValue_(values[i][2]) === today) {
      return { id: values[i][0], date: today, steps: Number(values[i][3]), caloriesBurned: Number(values[i][4]) };
    }
  }
  return null;
}

function upsertStepsToday_(email, steps) {
  const sheet = getOrCreateSheet_(STEPS_SHEET_NAME, STEPS_HEADER);
  const today = todayStr_();
  const nowTime = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'HH:mm:ss');

  const latestWeight = getLatestWeight_(email);
  const caloriesBurned = latestWeight ? calcStepsCalories_(latestWeight.weightKg, steps) : 0;

  if (sheet.getLastRow() >= 2) {
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
    for (let i = 0; i < values.length; i++) {
      if (values[i][1] === email && normalizeDateValue_(values[i][2]) === today) {
        sheet.getRange(i + 2, 4, 1, 3).setValues([[steps, caloriesBurned, nowTime]]);
        return { id: values[i][0], caloriesBurned: caloriesBurned };
      }
    }
  }
  const id = Utilities.getUuid();
  sheet.appendRow([id, email, today, steps, caloriesBurned, nowTime]);
  return { id: id, caloriesBurned: caloriesBurned };
}

/**
 * ==============================================================
 * 100日チャレンジ・ひとこと日記・継続日数
 * ==============================================================
 */

function getChallenge_(email) {
  const sheet = getOrCreateSheet_(CHALLENGE_SHEET_NAME, CHALLENGE_HEADER);
  if (sheet.getLastRow() < 2) return null;

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, CHALLENGE_HEADER.length).getValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i][0] === email) {
      return {
        startDate: normalizeDateValue_(values[i][1]),
        messages: { 25: values[i][2] || '', 50: values[i][3] || '', 75: values[i][4] || '', 100: values[i][5] || '' }
      };
    }
  }
  return null;
}

function upsertChallenge_(email, startDate, messages) {
  const sheet = getOrCreateSheet_(CHALLENGE_SHEET_NAME, CHALLENGE_HEADER);
  const now = nowStr_();
  const rowData = [email, startDate, messages[25], messages[50], messages[75], messages[100], now];

  const rowIndex = findRowIndexByKey_(sheet, email);
  if (rowIndex) {
    sheet.getRange(rowIndex, 1, 1, CHALLENGE_HEADER.length).setValues([rowData]);
  } else {
    sheet.appendRow(rowData);
  }
}

function buildChallengeInfo_(email, activeDays) {
  const challenge = getChallenge_(email);
  if (!challenge) return null;

  const today = todayStr_();
  const dayIndexRaw = daysBetween_(challenge.startDate, today) + 1;
  const dayIndex = Math.max(1, dayIndexRaw);
  const completed = dayIndexRaw > CHALLENGE_TOTAL_DAYS;
  const dayIndexClamped = Math.min(dayIndex, CHALLENGE_TOTAL_DAYS);
  const progressPercent = Math.min(100, Math.round((dayIndexClamped / CHALLENGE_TOTAL_DAYS) * 100));
  const loggedDays = countLoggedDaysInRange_(activeDays, challenge.startDate, today);

  const startWeight = getWeightOnOrAfter_(email, challenge.startDate);
  const latestWeight = getLatestWeight_(email);
  let weightDelta = null;
  if (startWeight && latestWeight) {
    weightDelta = Math.round((latestWeight.weightKg - startWeight.weightKg) * 10) / 10;
  }

  return {
    startDate: challenge.startDate, dayIndex: dayIndex, totalDays: CHALLENGE_TOTAL_DAYS,
    progressPercent: progressPercent, completed: completed, messages: challenge.messages,
    loggedDays: loggedDays, weightDelta: weightDelta
  };
}

function getTodayDiary_(email) {
  const sheet = getOrCreateSheet_(DIARY_SHEET_NAME, DIARY_HEADER);
  if (sheet.getLastRow() < 2) return '';

  const today = todayStr_();
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, DIARY_HEADER.length).getValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i][0] === email && normalizeDateValue_(values[i][1]) === today) return values[i][2] || '';
  }
  return '';
}

function upsertDiaryToday_(email, text) {
  const sheet = getOrCreateSheet_(DIARY_SHEET_NAME, DIARY_HEADER);
  const today = todayStr_();

  if (sheet.getLastRow() >= 2) {
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
    for (let i = 0; i < values.length; i++) {
      if (values[i][0] === email && normalizeDateValue_(values[i][1]) === today) {
        sheet.getRange(i + 2, 3, 1, 1).setValues([[text]]);
        return;
      }
    }
  }
  sheet.appendRow([email, today, text]);
}

function getActiveDaysSet_(email) {
  const days = {};

  const mealSheet = getOrCreateSheet_(MEAL_SHEET_NAME, MEAL_HEADER);
  if (mealSheet.getLastRow() >= 2) {
    mealSheet.getRange(2, 1, mealSheet.getLastRow() - 1, 3).getValues().forEach(function (row) {
      if (row[1] === email) days[normalizeDateValue_(row[2])] = true;
    });
  }

  const weightSheet = getOrCreateSheet_(WEIGHT_SHEET_NAME, WEIGHT_HEADER);
  if (weightSheet.getLastRow() >= 2) {
    weightSheet.getRange(2, 1, weightSheet.getLastRow() - 1, 3).getValues().forEach(function (row) {
      if (row[1] === email) days[normalizeDateValue_(row[2])] = true;
    });
  }

  const stepsSheet = getOrCreateSheet_(STEPS_SHEET_NAME, STEPS_HEADER);
  if (stepsSheet.getLastRow() >= 2) {
    stepsSheet.getRange(2, 1, stepsSheet.getLastRow() - 1, 3).getValues().forEach(function (row) {
      if (row[1] === email) days[normalizeDateValue_(row[2])] = true;
    });
  }

  const diarySheet = getOrCreateSheet_(DIARY_SHEET_NAME, DIARY_HEADER);
  if (diarySheet.getLastRow() >= 2) {
    diarySheet.getRange(2, 1, diarySheet.getLastRow() - 1, 2).getValues().forEach(function (row) {
      if (row[0] === email) days[normalizeDateValue_(row[1])] = true;
    });
  }

  return days;
}

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

function nowStr_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
}

/**
 * ==============================================================
 * 日付・時刻セルの正規化
 * （スプレッドシートが文字列を自動的に日付型に変換してしまった場合の救済）
 * ==============================================================
 */

function normalizeDateValue_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, 'Asia/Tokyo', 'yyyy-MM-dd');
  }
  return String(value);
}

function normalizeTimeValue_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, 'Asia/Tokyo', 'HH:mm:ss');
  }
  return String(value);
}

function normalizeDateTimeValue_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  }
  return String(value);
}

/**
 * クライアントから送られてきた時刻入力（"HH:mm" または "HH:mm:ss"）を "HH:mm:ss" に正規化する。
 */
function normalizeTimeInput_(time) {
  const t = String(time || '').trim();
  if (/^\d{2}:\d{2}:\d{2}$/.test(t)) return t;
  if (/^\d{2}:\d{2}$/.test(t)) return t + ':00';
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'HH:mm:ss');
}

/**
 * ==============================================================
 * 食事記録（画像解析・追記・取得）
 * ==============================================================
 */

function analyzeFoodImage_(base64Image, mimeType) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('スクリプトプロパティに GEMINI_API_KEY が設定されていません');

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
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64Image } }] }],
    generationConfig: { responseMimeType: 'application/json' }
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

function saveImageToDrive_(base64Image, mimeType, email) {
  const folderId = PropertiesService.getScriptProperties().getProperty('DRIVE_FOLDER_ID');
  if (!folderId) return '';

  const folder = DriveApp.getFolderById(folderId);
  const decoded = Utilities.base64Decode(base64Image);
  const ext = mimeType.split('/')[1] || 'jpg';
  const safeName = (email || 'unknown').replace(/[^\w\u3040-\u30FF\u4E00-\u9FFF-]/g, '_');
  const fileName = safeName + '_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss') + '.' + ext;
  const blob = Utilities.newBlob(decoded, mimeType, fileName);
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}

function appendMealRecord_(email, analysis, imageUrl) {
  const sheet = getOrCreateSheet_(MEAL_SHEET_NAME, MEAL_HEADER);
  const now = new Date();
  const id = Utilities.getUuid();

  sheet.appendRow([
    id, email,
    Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd'),
    Utilities.formatDate(now, 'Asia/Tokyo', 'HH:mm:ss'),
    analysis.foodName, analysis.calories, analysis.protein, analysis.fat, analysis.carbs,
    imageUrl, analysis.note
  ]);
  return id;
}

function getTodayMealRecords_(email) {
  const sheet = getOrCreateSheet_(MEAL_SHEET_NAME, MEAL_HEADER);
  if (sheet.getLastRow() < 2) return [];

  const today = todayStr_();
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, MEAL_HEADER.length).getValues();

  return values
    .filter(function (row) { return row[1] === email && normalizeDateValue_(row[2]) === today; })
    .map(function (row) {
      return {
        id: row[0], date: normalizeDateValue_(row[2]), time: normalizeTimeValue_(row[3]), foodName: row[4],
        calories: row[5], protein: row[6], fat: row[7], carbs: row[8],
        imageUrl: row[9], note: row[10]
      };
    })
    .reverse();
}

/**
 * ==============================================================
 * 共通ユーティリティ
 * ==============================================================
 */

function findRowIndexByKey_(sheet, key) {
  if (sheet.getLastRow() < 2) return null;
  const keys = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < keys.length; i++) {
    if (keys[i][0] === key) return i + 2;
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
    applyPlainTextFormat_(sheet, name);
  }
  return sheet;
}

/**
 * 日付・時刻列をプレーンテキスト書式にする（スプレッドシートによる自動的な日付型変換を防ぐ）。
 * シート全体（最大行）に対して適用し、将来追加される行にも書式が引き継がれるようにする。
 */
function applyPlainTextFormat_(sheet, sheetName) {
  const config = DATE_TIME_COLUMN_CONFIG[sheetName];
  if (!config) return;

  const maxRows = sheet.getMaxRows();
  const cols = config.date.concat(config.time).concat(config.datetime);
  cols.forEach(function (col) {
    sheet.getRange(1, col, maxRows, 1).setNumberFormat('@');
  });
}

/**
 * 【修復用・手動実行】既存シートの日付・時刻列がスプレッドシートによって
 * 日付型セルに自動変換されてしまっている場合に、プレーンテキスト書式へ戻し、
 * 既に壊れてしまった値（Dateオブジェクト）を正しい文字列に書き戻す。
 * スクリプトエディタから一度だけ手動実行してください（実行 > repairDateFormatting）。
 */
function repairDateFormatting() {
  Object.keys(DATE_TIME_COLUMN_CONFIG).forEach(function (sheetName) {
    repairSheetDates_(sheetName, HEADER_BY_SHEET_[sheetName]);
  });
  Logger.log('日付・時刻列の修復が完了しました');
}

function repairSheetDates_(sheetName, header) {
  const config = DATE_TIME_COLUMN_CONFIG[sheetName];
  const sheet = getOrCreateSheet_(sheetName, header);

  applyPlainTextFormat_(sheet, sheetName);

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const values = sheet.getRange(2, 1, lastRow - 1, header.length).getValues();
  let changed = false;

  values.forEach(function (row) {
    config.date.forEach(function (col) {
      if (row[col - 1] instanceof Date) { row[col - 1] = normalizeDateValue_(row[col - 1]); changed = true; }
    });
    config.time.forEach(function (col) {
      if (row[col - 1] instanceof Date) { row[col - 1] = normalizeTimeValue_(row[col - 1]); changed = true; }
    });
    config.datetime.forEach(function (col) {
      if (row[col - 1] instanceof Date) { row[col - 1] = normalizeDateTimeValue_(row[col - 1]); changed = true; }
    });
  });

  if (changed) {
    sheet.getRange(2, 1, lastRow - 1, header.length).setValues(values);
  }
}

/**
 * 動作確認用：スクリプトエディタから実行してAPIキー疎通を確認する
 */
function testGeminiConnection() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  Logger.log(apiKey ? 'GEMINI_API_KEY は設定されています（' + apiKey.substring(0, 4) + '...）' : 'GEMINI_API_KEY が未設定です');
}
