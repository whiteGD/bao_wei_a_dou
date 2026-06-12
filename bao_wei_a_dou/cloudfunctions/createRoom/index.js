const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async function main(event) {
  const wxContext = cloud.getWXContext();
  const now = Date.now();
  const roomId = `R${now.toString(36).toUpperCase()}${Math.floor(Math.random() * 999).toString().padStart(3, '0')}`;
  const seed = `${roomId}_${now}_${Math.random()}`;

  const room = {
    roomId,
    status: 'waiting',
    mode: 'duel',
    roundId: 1,
    seed,
    battleStartAt: 0,
    states: {},
    players: [
      {
        openid: wxContext.OPENID,
        side: 'A',
        ready: true,
        hp: 3,
        gold: 20,
        recruitCount: 0,
        connected: true
      }
    ],
    pauseRequest: {
      fromSide: '',
      status: 'none',
      createdAt: 0
    },
    createdAt: now,
    updatedAt: now
  };

  // rooms 集合需要在云开发控制台创建。也可以首次部署后手动创建索引 roomId。
  await db.collection('rooms').add({ data: room });

  return {
    roomId,
    side: 'A',
    roundId: 1,
    seed,
    battleStartAt: 0,
    status: room.status
  };
};
