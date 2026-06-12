const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async function main(event) {
  const wxContext = cloud.getWXContext();
  const roomId = event.roomId;
  if (!roomId) throw new Error('缺少 roomId');

  const lookup = await db.collection('rooms').where({ roomId }).limit(1).get();
  if (!lookup.data.length) throw new Error('房间不存在');
  const roomDocId = lookup.data[0]._id;

  return db.runTransaction(async (transaction) => {
    const result = await transaction.collection('rooms').doc(roomDocId).get();
    const room = result.data;
    const players = room.players || [];
    const existingPlayer = players.find((player) => player.openid === wxContext.OPENID);

    // 阶段三：如果当前 openid 已经在房间内，说明是原玩家重连。
    // 此时不再要求房间必须是 waiting，也不占用第二个玩家位。
    if (existingPlayer) {
      return {
        roomId,
        side: existingPlayer.side,
        roundId: room.roundId || 1,
        seed: room.seed,
        battleStartAt: room.battleStartAt || 0,
        status: room.status,
        states: room.states || {},
        result: room.result || null
      };
    }

    // 只有新玩家加入时才校验房间必须还在等待中。
    if (room.status !== 'waiting') throw new Error('房间不可加入');
    if (players.length >= 2) throw new Error('房间已满');

    const player = {
      openid: wxContext.OPENID,
      side: 'B',
      ready: true,
      hp: 3,
      gold: 20,
      recruitCount: 0,
      connected: true
    };

    const battleStartAt = Date.now() + 3000;

    await transaction.collection('rooms').doc(room._id).update({
      data: {
        players: players.concat([player]),
        status: 'playing',
        battleStartAt,
        updatedAt: Date.now()
      }
    });

    return {
      roomId,
      side: 'B',
      roundId: room.roundId || 1,
      seed: room.seed,
      battleStartAt,
      status: 'playing',
      states: room.states || {}
    };
  });
};
