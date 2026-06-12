const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async function main(event) {
  const wxContext = cloud.getWXContext();
  const now = Date.now();
  const roomId = event.roomId;
  const action = event.action || 'ready';

  if (!roomId) throw new Error('缺少 roomId');

  const lookup = await db.collection('rooms').where({ roomId }).limit(1).get();
  if (!lookup.data.length) throw new Error('房间不存在');
  const roomDocId = lookup.data[0]._id;

  return db.runTransaction(async (transaction) => {
    const result = await transaction.collection('rooms').doc(roomDocId).get();
    const room = result.data;
    const player = (room.players || []).find((item) => item.openid === wxContext.OPENID);
    if (!player) throw new Error('你不在这个房间中');

    const roundId = room.roundId || 1;

    if (action === 'leave') {
      await transaction.collection('rooms').doc(roomDocId).update({
        data: {
          status: 'closed',
          leftSide: player.side,
          rematchReady: room.rematchReady || {},
          updatedAt: now
        }
      });
      return { ok: true, status: 'closed', leftSide: player.side, roundId };
    }

    if (room.status !== 'finished' && room.status !== 'rematch_waiting') {
      throw new Error('当前房间不能再来一局');
    }

    const rematchReady = Object.assign({}, room.rematchReady || {}, {
      [player.side]: now
    });
    const players = room.players || [];
    const allReady = players.length >= 2 && players.every((item) => rematchReady[item.side]);

    if (!allReady) {
      await transaction.collection('rooms').doc(roomDocId).update({
        data: {
          status: 'rematch_waiting',
          rematchReady,
          updatedAt: now
        }
      });
      return { ok: true, status: 'rematch_waiting', roundId };
    }

    const nextRoundId = roundId + 1;
    const seed = `${roomId}_${nextRoundId}_${now}_${Math.random()}`;
    const battleStartAt = now + 3000;

    await transaction.collection('rooms').doc(roomDocId).update({
      data: {
        status: 'playing',
        roundId: nextRoundId,
        seed,
        battleStartAt,
        states: {},
        failures: [],
        result: null,
        rematchReady: {},
        leftSide: '',
        updatedAt: now
      }
    });

    return {
      ok: true,
      status: 'playing',
      roundId: nextRoundId,
      seed,
      battleStartAt
    };
  });
};
