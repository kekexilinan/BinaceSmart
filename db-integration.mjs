/**
 * db-integration.mjs
 * 将 DB 存储集成到推送流程的桥接模块
 * 在 server.mjs 中 import 并在 savePushMock 后调用
 */
import { initDB, insertSentiment, insertSymbolSnapshots, insertDecisionSnapshot, persistDB, closeDB } from './db.mjs';

let dbReady = false;

/** 初始化 DB（启动时调用一次） */
export async function initDBStorage() {
  try {
    await initDB();
    dbReady = true;
    console.log('  \u2713 DB \u5b58\u50a8\u5df2\u542f\u7528');
  } catch (e) {
    console.warn(`  \u26a0 DB \u5b58\u50a8\u521d\u59cb\u5316\u5931\u8d25: ${e.message}`);
  }
}

/**
 * 在每次推送完成后调用，将数据存入 SQLite
 * @param {object} params - 与 savePushMock 的 snapshot 结构对齐
 */
export function saveToDatabase({ outlook, enrichedRows, decisionPush, poolSize }) {
  if (!dbReady) return;
  try {
    if (outlook) {
      insertSentiment(outlook, poolSize || 0);
    }
    if (enrichedRows?.length) {
      insertSymbolSnapshots(enrichedRows);
    }
    if (decisionPush) {
      insertDecisionSnapshot(decisionPush);
    }
  } catch (e) {
    console.warn(`  \u26a0 DB \u5199\u5165\u5931\u8d25: ${e.message}`);
  }
}

export { persistDB, closeDB };
