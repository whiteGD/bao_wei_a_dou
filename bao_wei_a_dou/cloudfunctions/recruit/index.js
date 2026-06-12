const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const BASIC_UNIT_IDS = ['spear', 'blade', 'bow', 'cavalry'];
const SPECIAL_CHARS = ['张', '飞', '赵', '云', '刘', '备', '关', '羽', '马', '超', '黄', '忠'];
const RECRUIT_WEIGHTS = { basic: 68, specialChar: 20, shovel: 12 };

exports.main = async function main(event) {
  const roomId = event.roomId;
  const side = event.side;
  const recruitCount = event.recruitCount || 0;
  const occupiedSpecialChars = event.occupiedSpecialChars || [];
  const seed = `${event.seed || roomId || 'room'}_${side}_${recruitCount}`;
  const rng = new SeededRandom(seed);
  const items = [];
  const usedSpecialInRound = {};

  for (let i = 0; i < 5; i += 1) {
    const roll = rng.next() * 100;
    if (roll < RECRUIT_WEIGHTS.basic) {
      items.push({ kind: 'basic', unitId: rng.pick(BASIC_UNIT_IDS), level: 1 });
      continue;
    }

    if (roll < RECRUIT_WEIGHTS.basic + RECRUIT_WEIGHTS.specialChar) {
      const pool = SPECIAL_CHARS.filter((char) => (
        occupiedSpecialChars.indexOf(char) === -1 && !usedSpecialInRound[char]
      ));

      if (pool.length > 0) {
        const char = rng.pick(pool);
        usedSpecialInRound[char] = true;
        items.push({ kind: 'specialChar', char });
      } else {
        items.push({ kind: 'basic', unitId: rng.pick(BASIC_UNIT_IDS), level: 1 });
      }
      continue;
    }

    items.push({ kind: 'shovel' });
  }

  if (roomId) {
    await db.collection('roomLogs').add({
      data: {
        roomId,
        playerSide: side,
        type: 'RECRUIT',
        payload: { recruitCount, items },
        createdAt: Date.now()
      }
    });
  }

  return { items };
};

class SeededRandom {
  constructor(seed) {
    this.seed = hashString(String(seed));
  }

  next() {
    let t = this.seed += 0x6d2b79f5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  pick(list) {
    return list[Math.floor(this.next() * list.length)];
  }
}

function hashString(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
