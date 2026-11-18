// ============================================================
// 食卓帳 設定ファイル
// GAS URL・Geminiモデル・バージョンはここだけ書き換えればOK
// ============================================================
window.APP_CONFIG = {
  // フロントエンドのバージョン（画面下部に表示）
  APP_VERSION: 'v1.1.0',

  // GASのWebアプリ公開URL（.../exec）
  GAS_EXEC_URL: 'https://script.google.com/macros/s/AKfycbzHLbZzMjTqCuLsTp6QJWdGETWzJ7XNcI87VBA9anlFp-rziCQH4XosWBNo9j2sX80qyg/exec',

  // 食事写真の解析に使うGeminiモデル
  // 例: 'gemini-3.6-flash' / 'gemini-3.5-flash' / 'gemini-3.5-flash-lite' など
  // 空文字、または指定したモデルが存在しない場合は
  // 汎用の最新モデル 'gemini-flash-latest' が自動で使われる
  GEMINI_MODEL: 'gemini-3.5-flash'
};
