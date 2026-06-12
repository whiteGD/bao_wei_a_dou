const { CLOUD_ENV_ID, RECRUIT_WEIGHTS, BASIC_UNIT_IDS, SPECIAL_CHARS, ITEM_KIND } = require('./config');
const { SeededRandom, makeId } = require('./utils');

/**
 * 云开发服务封装。
 * 设计目标：
 * 1. 云环境 ID 未配置时也能本地运行，便于先开发游戏玩法。
 * 2. 云函数可用后，入口方法不变，只替换为真实云函数结果。
 */
class CloudService {
  constructor() {
    this.enabled = false;
    this.localRoom = null;
    this.localSeq = 0;
  }

  // 初始化微信云开发。没有配置 CLOUD_ENV_ID 时，自动降级为本地模拟模式。
  init() {
    if (typeof wx === 'undefined' || !wx.cloud || !CLOUD_ENV_ID) {
      this.enabled = false;
      return;
    }

    wx.cloud.init({
      env: CLOUD_ENV_ID,
      traceUser: true
    });
    this.enabled = true;
  }

  // 创建房间。云模式调用云函数，本地模式返回一个模拟房间对象。
  async createRoom() {
    if (this.enabled) {
      return this.callFunction('createRoom', {});
    }

    this.localRoom = {
      roomId: makeId('room'),
      side: 'A',
      seed: String(Date.now()),
      status: 'playing'
    };
    return this.localRoom;
  }

  // 加入房间。当前本地模式只保留 roomId 和随机种子，方便先测试玩法流程。
  async joinRoom(roomId) {
    if (this.enabled) {
      return this.callFunction('joinRoom', { roomId });
    }

    this.localRoom = {
      roomId: roomId || makeId('room'),
      side: 'B',
      seed: String(Date.now()),
      status: 'playing'
    };
    return this.localRoom;
  }

  // 征兵入口。云模式交给云函数，本地模式用同一套随机规则生成 5 个候选项。
  async recruit(payload) {
    if (this.enabled) {
      return this.callFunction('recruit', payload);
    }

    return {
      seq: this.localSeq += 1,
      items: createRecruitItems(payload)
    };
  }

  // 结束游戏入口。云模式可记录结算，本地模式只返回成功结果。
  async finishGame(payload) {
    if (this.enabled) {
      return this.callFunction('finishGame', payload);
    }
    return { ok: true, payload };
  }

  // 微信云函数通用调用封装，统一返回 res.result。
  callFunction(name, data) {
    return new Promise((resolve, reject) => {
      wx.cloud.callFunction({
        name,
        data,
        success: (res) => resolve(res.result || res),
        fail: reject
      });
    });
  }
}

/**
 * 本地征兵算法与 cloudfunctions/recruit 保持同一规则。
 * 这里过滤场上已有特殊字，避免同一个特殊字重复出现。
 */
function createRecruitItems(payload) {
  const occupiedSpecialChars = payload.occupiedSpecialChars || [];
  const seed = `${payload.seed || 'local'}_${payload.side}_${payload.recruitCount}`;
  const rng = new SeededRandom(seed);
  const items = [];
  const usedSpecialInRound = {};

  for (let i = 0; i < 5; i += 1) {
    const roll = rng.next() * 100;
    if (roll < RECRUIT_WEIGHTS.basic) {
      const unitId = rng.pick(BASIC_UNIT_IDS);
      items.push({ kind: ITEM_KIND.BASIC, unitId, level: 1 });
      continue;
    }

    if (roll < RECRUIT_WEIGHTS.basic + RECRUIT_WEIGHTS.specialChar) {
      const pool = SPECIAL_CHARS.filter((char) => (
        occupiedSpecialChars.indexOf(char) === -1 && !usedSpecialInRound[char]
      ));

      if (pool.length > 0) {
        const char = rng.pick(pool);
        usedSpecialInRound[char] = true;
        items.push({ kind: ITEM_KIND.SPECIAL_CHAR, char });
      } else {
        // 如果特殊字池已经空了，回退为基础单位，保证候选格一定有内容。
        const unitId = rng.pick(BASIC_UNIT_IDS);
        items.push({ kind: ITEM_KIND.BASIC, unitId, level: 1 });
      }
      continue;
    }

    items.push({ kind: ITEM_KIND.SHOVEL });
  }

  return items;
}

module.exports = { CloudService, createRecruitItems };
