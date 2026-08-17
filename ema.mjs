/**
 * 通用 EMA（指数移动平均）计算模块
 * 被 scan-stable / auto-trader 等多处复用
 */

/**
 * 计算 EMA 序列（与输入等长，首项为 data[0]）。
 * 采用经典递推公式：ema[i] = data[i] * k + ema[i-1] * (1 - k)，k = 2 / (period + 1)
 * @param {number[]} data 原始数据（建议为收盘价）
 * @param {number} period EMA 周期（如 7, 12, 25, 26）
 * @returns {number[]} 与 data 同长的 EMA 数组
 */
export function ema(data, period) {
  if (!Array.isArray(data) || data.length === 0) return [];
  if (!Number.isFinite(period) || period <= 0) return data.map(() => NaN);
  const k = 2 / (period + 1);
  const result = [data[0]];
  for (let i = 1; i < data.length; i++) {
    const v = Number.isFinite(data[i]) ? data[i] : result[i - 1];
    result.push(v * k + result[i - 1] * (1 - k));
  }
  return result;
}

/**
 * 只返回最后一个 EMA 值（节省内存）。
 * @param {number[]} data 原始数据
 * @param {number} period EMA 周期
 * @returns {number|null}
 */
export function emaLast(data, period) {
  if (!Array.isArray(data) || data.length === 0) return null;
  if (!Number.isFinite(period) || period <= 0) return NaN;
  const k = 2 / (period + 1);
  let prev = data[0];
  for (let i = 1; i < data.length; i++) {
    const v = Number.isFinite(data[i]) ? data[i] : prev;
    prev = v * k + prev * (1 - k);
  }
  return prev;
}

/**
 * 从币安 kline 数组提取收盘价序列。
 * @param {Array} klines 币安 kline 原始数组（每条为 [openTime, open, high, low, close, ...]）
 * @returns {number[]}
 */
export function closesOf(klines) {
  if (!Array.isArray(klines)) return [];
  return klines.map(k => parseFloat(k[4]));
}
