const { CLOUD_ENV_ID, RECRUIT_WEIGHTS, BASIC_UNIT_IDS, SPECIAL_CHARS, ITEM_KIND } = require('./config');
const { SeededRandom, makeId } = require('./utils');

class CloudService {
  constructor() {
    this.enabled = false;
    this.localRoom = null;
    this.localSeq = 0;
    this.db = null;
  }

  init() {
    if (typeof wx === 'undefined' || !wx.cloud || !CLOUD_ENV_ID) {
      this.enabled = false;
      return;
    }

    wx.cloud.init({
      env: CLOUD_ENV_ID,
      traceUser: true
    });
    this.db = wx.cloud.database();
    this.enabled = true;
  }

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

  async recruit(payload) {
    if (this.enabled) {
      return this.callFunction('recruit', payload);
    }

    return {
      seq: this.localSeq += 1,
      items: createRecruitItems(payload)
    };
  }

  async finishGame(payload) {
    if (this.enabled) {
      return this.callFunction('finishGame', payload);
    }
    return { ok: true, payload };
  }

  async getRoom(roomId) {
    if (!this.enabled || !roomId || !this.db) return null;
    const result = await this.db.collection('rooms').where({ roomId }).limit(1).get();
    return result.data && result.data[0] ? result.data[0] : null;
  }

  watchRoom(roomId, onChange, onError) {
    if (!this.enabled || !roomId || !this.db || !this.db.collection('rooms').where) {
      return null;
    }

    return this.db.collection('rooms')
      .where({ roomId })
      .watch({
        onChange: (snapshot) => {
          const room = snapshot.docs && snapshot.docs[0];
          if (room) onChange(room);
        },
        onError: onError || ((err) => console.warn('watch room error', err))
      });
  }

  watchRoomLogs(roomId, onLogs, onError) {
    if (!this.enabled || !roomId || !this.db || !this.db.collection('roomLogs').where) {
      return null;
    }

    return this.db.collection('roomLogs')
      .where({ roomId })
      .watch({
        onChange: (snapshot) => {
          const logs = snapshot.docChanges
            .filter((change) => change.dataType === 'add')
            .map((change) => change.doc);
          if (logs.length > 0) onLogs(logs);
        },
        onError: onError || ((err) => console.warn('watch logs error', err))
      });
  }

  async logAction(payload) {
    if (!this.enabled || !payload.roomId || !this.db) {
      this.localSeq += 1;
      return { ok: true, seq: this.localSeq };
    }

    return this.callFunction('logAction', payload);
  }

  closeWatcher(watcher) {
    if (watcher && watcher.close) {
      watcher.close();
    }
  }

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
