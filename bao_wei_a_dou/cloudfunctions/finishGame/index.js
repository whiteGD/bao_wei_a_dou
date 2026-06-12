const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async function main(event) {
  const wxContext = cloud.getWXContext();
  const now = Date.now();
  const roomId = event.roomId;
  const reason = event.reason || 'baseDestroyed';

  if (!roomId) throw new Error('缺少 roomId');

  const lookup = await db.collection('rooms').where({ roomId }).limit(1).get();
  if (!lookup.data.length) throw new Error('房间不存在');
  const roomDocId = lookup.data[0]._id;

  const settlement = await db.runTransaction(async (transaction) => {
    const roomResult = await transaction.collection('rooms').doc(roomDocId).get();
    const room = roomResult.data;

    if (room.status === 'finished' && room.result) {
      return { ok: true, result: room.result, shouldRecord: false };
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

    await transaction.collection('rooms').doc(roomDocId).update({
      data: {
        status: 'finished',
        failures,
        result,
        updatedAt: now
      }
    });

    return { ok: true, result, side, shouldRecord: true };
  });

  if (settlement.shouldRecord) {
    await db.collection('battleRecords').add({
      data: {
        roomId,
        winner: settlement.result.winner,
        failedSide: settlement.result.failedSide,
        reason: settlement.result.reason,
        reportedBy: wxContext.OPENID,
        createdAt: now
      }
    });

    await db.collection('roomLogs').add({
      data: {
        roomId,
        playerSide: settlement.side,
        type: 'FINISH',
        payload: settlement.result,
        createdBy: wxContext.OPENID,
        createdAt: now
      }
    });
  }

  return { ok: true, result: settlement.result };
};
