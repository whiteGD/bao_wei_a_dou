const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async function main(event) {
  const wxContext = cloud.getWXContext();
  const now = Date.now();
  const roomId = event.roomId;
  const reason = event.reason || 'baseDestroyed';

  if (!roomId) throw new Error('缺少 roomId');

  const rooms = await db.collection('rooms').where({ roomId }).limit(1).get();
  if (!rooms.data.length) throw new Error('房间不存在');

  const room = rooms.data[0];
  if (room.status === 'finished' && room.result) {
    return { ok: true, result: room.result };
  }

  const player = (room.players || []).find((item) => item.openid === wxContext.OPENID);
  if (!player) throw new Error('你不在这个房间中');

  const side = player.side;
  const existingFailures = room.failures || [];
  const failures = existingFailures.some((item) => item.side === side)
    ? existingFailures
    : existingFailures.concat([{
      side,
      openid: wxContext.OPENID,
      reason,
      failedAt: now
    }]);

  const firstFailure = failures
    .slice()
    .sort((a, b) => {
      const timeDiff = (a.failedAt || 0) - (b.failedAt || 0);
      if (timeDiff !== 0) return timeDiff;
      return String(a.side).localeCompare(String(b.side));
    })[0];

  const failedSide = firstFailure.side;
  const winner = failedSide === 'A' ? 'B' : 'A';
  const result = {
    winner,
    failedSide,
    reason: firstFailure.reason || reason,
    finishedAt: firstFailure.failedAt || now,
    decidedBy: 'failureReport'
  };

  await db.collection('rooms').doc(room._id).update({
    data: {
      status: 'finished',
      failures,
      result,
      updatedAt: now
    }
  });

  await db.collection('battleRecords').add({
    data: {
      roomId,
      winner,
      failedSide,
      reason: result.reason,
      reportedBy: wxContext.OPENID,
      createdAt: now
    }
  });

  await db.collection('roomLogs').add({
    data: {
      roomId,
      playerSide: side,
      type: 'FINISH',
      payload: result,
      createdBy: wxContext.OPENID,
      createdAt: now
    }
  });

  return { ok: true, result };
};
