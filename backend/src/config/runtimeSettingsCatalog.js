// 運用チューニング値（判定半径・タイムアウト・しきい値など）の定義カタログ。
//
// これまで環境変数（.env）でしか調整できなかった値、および一部コードに直書きされていた値
// （GPS_STALE_TIMEOUT_MIN。旧・finishService.js の `elapsedGpsMin >= 3` 直書き）を、
// 管理画面（GET/PUT/DELETE /api/admin/runtime-settings）から編集できるようにするための
// 定義一覧。実際の値の解決は services/runtimeSettings.js が行う
// （優先順位: 管理画面での上書き値(DB) > 環境変数 > このファイルのdefault）。
//
// キー名は既存の環境変数名をそのまま使う（GPS_STALE_TIMEOUT_MINのみ新規）。
// default は「これまでコード中に直書きされていた既定値」と完全に一致させてあり、
// 管理画面・環境変数のどちらでも上書きしなければ従来と全く同じ挙動になる。
//
// requiresRestart: true の項目は、起動時（サーバー起動直後）にしか読まれない
// （setIntervalの間隔として使われるため）。管理画面から変更しても、次回のサーバー再起動まで
// 反映されない。それ以外の項目は次回のパイプライン実行（既定60秒間隔）までに反映される。

const SETTINGS_CATALOG = [
  // ---- バス停到着・GPS ----
  {
    key: 'STOP_RADIUS_METERS',
    group: 'gps',
    groupLabel: '位置情報・通過判定',
    type: 'number',
    default: 120,
    min: 1,
    max: 2000,
    unit: 'm',
    label: 'バス停到着判定の半径',
    description: 'GPSがバス停からこの距離以内に入ったとき「到着」とみなします。狭すぎるとGPS誤差で未到着のままになり、広すぎると手前のバス停で誤って到着扱いになります。'
  },
  {
    key: 'GPS_FRESHNESS_MIN',
    group: 'gps',
    groupLabel: '位置情報・通過判定',
    type: 'integer',
    default: 15,
    min: 1,
    max: 180,
    unit: '分',
    label: 'GPSデータの有効期限',
    description: 'この時間より古いGPS点は、位置情報取得・通過判定に使いません。'
  },
  {
    key: 'DEPARTURE_MARGIN_METERS',
    group: 'gps',
    groupLabel: '位置情報・通過判定',
    type: 'number',
    default: 20,
    min: 1,
    max: 500,
    unit: 'm',
    label: '到着確定の離脱マージン',
    description: '「付近」状態のバス停から、記録済みの最小距離＋この距離だけ離れたことを検知した時点で「到着済」に確定します。狭すぎるとGPS誤差で確定が早まり、広すぎると確定が遅れます。'
  },

  // ---- 車両割り当て ----
  {
    key: 'ASSIGN_RADIUS_METERS',
    group: 'assignment',
    groupLabel: '車両割り当て',
    type: 'number',
    default: 100,
    min: 1,
    max: 2000,
    unit: 'm',
    label: '割り当て候補とみなす半径',
    description: '始発時刻時点で、始発バス停からこの距離以内にいる車両だけを割り当て候補にします（通過判定の半径とは別設定です）。'
  },
  {
    key: 'ASSIGN_GPS_WINDOW_MIN',
    group: 'assignment',
    groupLabel: '車両割り当て',
    type: 'number',
    default: 3,
    min: 0.5,
    max: 60,
    unit: '分',
    label: '割り当て判定に使うGPSの時間窓',
    description: '始発時刻のこの時間前から始発時刻までの間（閉区間）の最新GPSだけを、車両割り当ての判定に使います。'
  },
  {
    key: 'ASSIGN_DELAY_SEC',
    group: 'assignment',
    groupLabel: '車両割り当て',
    type: 'integer',
    default: 60,
    min: 0,
    max: 600,
    unit: '秒',
    label: '割り当て判定を待つ時間',
    description: '始発時刻からこの秒数だけ待ってから割り当て判定を行います（位置情報フィードの配信遅れを吸収するため）。判定に使うGPSの時間窓自体は変わりません。'
  },
  {
    key: 'ASSIGN_SAME_PERIOD_MIN',
    group: 'assignment',
    groupLabel: '車両割り当て',
    type: 'number',
    default: 10,
    min: 0,
    max: 120,
    unit: '分',
    label: '同時刻帯とみなす始発時刻の差',
    description: '始発時刻の差がこの時間以内の便どうしでは、同じ車両を担当車両として重複させません（例: 8:00便の担当車両は8:11便の担当になれます）。'
  },

  // ---- 運行終了判定 ----
  {
    key: 'GPS_STALE_TIMEOUT_MIN',
    group: 'finish',
    groupLabel: '運行終了判定',
    type: 'number',
    default: 6,
    min: 1,
    max: 60,
    unit: '分',
    label: 'GPS途絶とみなす経過時間',
    description: '車両の最新GPSからこの時間が経過すると「GPS途絶」として運行終了処理の対象にします。位置情報フィードの配信遅れやトンネル等の測位不良で短時間の途絶が発生することがあるため、短すぎると便が復帰不能になる場合があります。'
  },
  {
    key: 'GPS_TIMEOUT_TERMINAL_RADIUS_METERS',
    group: 'finish',
    groupLabel: '運行終了判定',
    type: 'number',
    default: 300,
    min: 1,
    max: 3000,
    unit: 'm',
    label: 'GPS途絶時の終点到着救済半径',
    description: 'GPSが途絶した車両について、未到達バス停が終点のみ残っている場合に限り、直近GPSが終点からこの距離以内なら「終点到着」とみなして運行終了にします（途絶中は測位精度が落ちる前提のため広めにとります）。'
  },
  {
    key: 'VEHICLE_MAX_AGE_MIN',
    group: 'finish',
    groupLabel: '運行終了判定',
    type: 'integer',
    default: 120,
    min: 1,
    max: 1440,
    unit: '分',
    label: '割り当ての強制終了までの経過時間',
    description: '割り当てからこの時間が経過した便への割り当ては、他の終了条件を満たさなくても強制的に終了します。'
  },
  {
    key: 'FINISH_PROTECTION_MIN',
    group: 'finish',
    groupLabel: '運行終了判定',
    type: 'integer',
    default: 10,
    min: 0,
    max: 120,
    unit: '分',
    label: '運行終了判定の保護期間',
    description: '割り当て直後のこの期間は、終点到着・GPS途絶による終了判定を行いません（割り当て直後の誤判定を防ぐため）。'
  },

  // ---- ETA予測 ----
  {
    key: 'ETA_BLEND_WEIGHT',
    group: 'eta',
    groupLabel: 'ETA予測',
    type: 'number',
    default: 0.55,
    min: 0,
    max: 1,
    unit: null,
    label: 'ETA予測における過去統計への信頼度',
    description: '区間別の到着予測で、過去統計と直近の走行ペース(liveFactor)をどれだけの比率でブレンドするか（0〜1）。1に近いほど過去統計を重視し、0に近いほど直近のペースを重視します。既定0.55は「55%は過去統計、残り45%分は直近ペースで揺らす」という按分です。'
  },

  // ---- 深夜運行停止時間帯 ----
  {
    key: 'NIGHT_START',
    group: 'night',
    groupLabel: '深夜運行停止時間帯',
    type: 'time',
    default: '23:00',
    label: '深夜運行停止の開始時刻',
    description: 'この時刻からNIGHT_ENDまでの間、位置情報取得・通過判定・車両割り当て等を停止します（当日便の生成のみ継続します）。HH:mm形式で指定してください。'
  },
  {
    key: 'NIGHT_END',
    group: 'night',
    groupLabel: '深夜運行停止時間帯',
    type: 'time',
    default: '05:00',
    label: '深夜運行停止の終了時刻',
    description: '深夜運行停止が終わる時刻。最も早い便が5:40発のため、これより遅くすると当日便の生成が始発に間に合わなくなるおそれがあります。HH:mm形式で指定してください。'
  },

  // ---- データ保持・更新間隔 ----
  {
    key: 'DAILY_TRIP_RETENTION_DAYS',
    group: 'retention',
    groupLabel: 'データ保持・更新間隔',
    type: 'integer',
    default: 7,
    min: 1,
    max: 365,
    unit: '日',
    label: '当日便データの保持日数',
    description: 'この日数を過ぎた当日便(daily_trips)のデータを掃除します（1時間ごとに実行）。'
  },
  {
    key: 'GPS_LOG_RETENTION_HOURS',
    group: 'retention',
    groupLabel: 'データ保持・更新間隔',
    type: 'integer',
    default: 48,
    min: 1,
    max: 24 * 30,
    unit: '時間',
    label: 'GPSログの保持時間',
    description: 'この時間を過ぎたGPSログ(vehicle_gps_log等)を掃除します（1時間ごとに実行）。'
  },
  {
    key: 'COMPLETED_TRIP_RETENTION_DAYS',
    group: 'retention',
    groupLabel: 'データ保持・更新間隔',
    type: 'integer',
    default: 7,
    min: 1,
    max: 365,
    unit: '日',
    label: '運行実績アーカイブの保持日数',
    description: 'この日数を過ぎた運行実績(completed_trips / completed_trip_stop_times)を掃除します（1時間ごとに実行）。ETA予測に使う区間別の平均(segment_travel_stats)は便のクローズ時に反映済みのため影響を受けませんが、管理画面「運行実績ダウンロード」でエクスポートできるのはこの日数以内の便だけになります。'
  },
  {
    key: 'SEGMENT_STATS_MAX_SAMPLES',
    group: 'retention',
    groupLabel: 'データ保持・更新間隔',
    type: 'integer',
    default: 500,
    min: 10,
    max: 100000,
    unit: '件',
    label: '区間統計の実効サンプル数上限',
    description: '区間別走行時間の平均(segment_travel_stats)を更新する際、1区間・1バケットあたりこの件数を超えると、それ以降は指数移動平均として古いサンプルを徐々に忘れます。生の走行データは保持期間を過ぎると消えるため、ダイヤ改正や道路事情の変化に平均が追従できるようにするための設定です。大きくすると平均は安定しますが変化への追従が遅くなります。'
  },
  {
    key: 'GTFS_UPDATE_INTERVAL_MIN',
    group: 'retention',
    groupLabel: 'データ保持・更新間隔',
    type: 'integer',
    default: 60,
    min: 0,
    max: 1440,
    unit: '分',
    label: 'GTFSフィードの更新間隔',
    description: 'この間隔でGTFS ZIPフィードの再取得を行います。0以下を指定すると毎回（パイプライン実行のたび）更新します。'
  },
  {
    key: 'POLL_INTERVAL_SECONDS',
    group: 'retention',
    groupLabel: 'データ保持・更新間隔',
    type: 'integer',
    default: 60,
    min: 10,
    max: 600,
    unit: '秒',
    label: 'メインパイプラインのポーリング間隔',
    description: '位置情報取得・通過判定・遅延計算・到着予測を行うメインパイプラインの実行間隔です。',
    requiresRestart: true
  },
  {
    key: 'SERVICE_STATUS_POLL_INTERVAL_MIN',
    group: 'retention',
    groupLabel: 'データ保持・更新間隔',
    type: 'integer',
    default: 60,
    min: 1,
    max: 1440,
    unit: '分',
    label: 'アルピコ運行状況の取得間隔',
    description: 'アルピコ交通「現在の運行状況」ページをスクレイピングする間隔です（/servicestatus画面用）。',
    requiresRestart: true
  },

  // ---- 閲覧数 ----
  {
    key: 'HIGH_LOAD_VIEWER_THRESHOLD',
    group: 'viewers',
    groupLabel: '閲覧数・負荷判定',
    type: 'integer',
    default: 50,
    min: 1,
    max: 100000,
    unit: '人',
    label: 'サーバー高負荷とみなす同時閲覧数',
    description: '同時アクティブ閲覧数がこの値以上のとき「サーバー高負荷」とみなし、利用者向け画面にポップアップを出したうえで自動更新を一時的にOFFにします。'
  },

  // ---- 管理画面アラートしきい値 ----
  {
    key: 'ADMIN_STALE_GPS_MIN',
    group: 'alerts',
    groupLabel: '管理画面アラートのしきい値',
    type: 'number',
    default: 5,
    min: 0,
    max: 180,
    unit: '分',
    label: 'GPS途絶アラートのしきい値',
    description: '稼働中の車両の最新GPSがこの時間以上更新されていない場合、管理画面のダッシュボード・アラートに計上します（運行終了判定のGPS途絶とは独立した、監視表示専用のしきい値です）。'
  },
  {
    key: 'ADMIN_DELAY_ALERT_MIN',
    group: 'alerts',
    groupLabel: '管理画面アラートのしきい値',
    type: 'number',
    default: 5,
    min: 0,
    max: 180,
    unit: '分',
    label: '遅延アラートのしきい値',
    description: '担当車両の遅延がこの分数以上のとき、管理画面のダッシュボード・アラートに計上します。'
  },
  {
    key: 'ADMIN_SEVERE_DELAY_MIN',
    group: 'alerts',
    groupLabel: '管理画面アラートのしきい値',
    type: 'number',
    default: 15,
    min: 0,
    max: 300,
    unit: '分',
    label: '大幅遅延アラートのしきい値',
    description: '担当車両の遅延がこの分数以上のとき、管理画面のアラートで「大幅遅延」として計上します。'
  },
  {
    key: 'ADMIN_UNASSIGNED_OVERDUE_MIN',
    group: 'alerts',
    groupLabel: '管理画面アラートのしきい値',
    type: 'number',
    default: 5,
    min: 0,
    max: 180,
    unit: '分',
    label: '未割当超過アラートのしきい値',
    description: '始発時刻を過ぎてもこの分数以上担当車両が割り当たっていない便を、管理画面のアラートに計上します。'
  },
  {
    key: 'ADMIN_ETA_STALE_MIN',
    group: 'alerts',
    groupLabel: '管理画面アラートのしきい値',
    type: 'number',
    default: 10,
    min: 0,
    max: 180,
    unit: '分',
    label: '予測停滞アラートのしきい値',
    description: '到着予測(trip_arrival_predictions)がこの分数以上更新されていない場合、管理画面のアラートに計上します。'
  }
];

const SETTINGS_BY_KEY = new Map(SETTINGS_CATALOG.map((def) => [def.key, def]));

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 管理画面から送られてきた文字列値を、その設定項目の型に照らして検証する。
 * @returns {string|null} エラーメッセージ。問題なければnull。
 */
function validateSettingValue(def, rawValue) {
  if (def.type === 'time') {
    if (!TIME_PATTERN.test(rawValue)) {
      return '時刻はHH:mm形式（例: 23:00）で指定してください。';
    }
    return null;
  }

  if (def.type === 'integer') {
    if (!/^-?\d+$/.test(rawValue)) {
      return '整数で入力してください。';
    }
    const n = parseInt(rawValue, 10);
    if (def.min !== undefined && n < def.min) return `${def.min}以上の値を入力してください。`;
    if (def.max !== undefined && n > def.max) return `${def.max}以下の値を入力してください。`;
    return null;
  }

  if (def.type === 'number') {
    if (rawValue.trim() === '' || Number.isNaN(Number(rawValue))) {
      return '数値で入力してください。';
    }
    const n = Number(rawValue);
    if (def.min !== undefined && n < def.min) return `${def.min}以上の値を入力してください。`;
    if (def.max !== undefined && n > def.max) return `${def.max}以下の値を入力してください。`;
    return null;
  }

  return null;
}

module.exports = { SETTINGS_CATALOG, SETTINGS_BY_KEY, validateSettingValue };
