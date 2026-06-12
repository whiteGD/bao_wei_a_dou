const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

exports.main = async function main(event) {
  const wxContext = cloud.getWXContext();
  const roomId = event.roomId;
  if (!roomId) throw new Error('缺少 roomId');

  const result = await db.collection('rooms').where({ roomId }).limit(1).get();
  if (!result.data.length) throw new Error('房间不存在');

  const room = result.data[0];
  if (room.status !== 'waiting') throw new Error('房间不可加入');
  if (room.players.length >= 2) throw new Error('房间已满');

  const player = {
    openid: wxContext.OPENID,
    side: 'B',
    ready: true,
    hp: 3,
    gold: 20,
    recruitCount: 0,
    connected: true
  };

  await db.collection('rooms').doc(room._id).update({
    data: {
      players: _.push(player),
      status: 'playing',
      updatedAt: Date.now()
    }
  });

  return {
    roomId,
    side: 'B',
    seed: room.seed,
    status: 'playing'
  };
};
