const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

/**
 * 统一写入房间操作日志。
 * 客户端不直接写 roomLogs，而是走云函数：
 * 1. 可以绕开客户端数据库写权限限制。
 * 2. 可以在服务端校验调用者确实属于这个房间。
 */
exports.main = async function main(event) {
  const wxContext = cloud.getWXContext();
  const roomId = event.roomId;
  if (!roomId) throw new Error('缺少 roomId');

  const rooms = await db.collection('rooms').where({ roomId }).limit(1).get();
  if (!rooms.data.length) throw new Error('房间不存在');

  const room = rooms.data[0];
  const player = (room.players || []).find((item) => item.openid === wxContext.OPENID);
  if (!player) throw new Error('你不在这个房间中');

  const log = {
    roomId,
    roundId: room.roundId || 1,
    playerSide: player.side,
    type: event.type,
    payload: event.payload || {},
    createdBy: wxContext.OPENID,
    createdAt: Date.now()
  };

  await db.collection('roomLogs').add({ data: log });
  return { ok: true };
};
