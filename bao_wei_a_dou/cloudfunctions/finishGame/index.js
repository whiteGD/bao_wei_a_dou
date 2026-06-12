const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async function main(event) {
  const wxContext = cloud.getWXContext();
  const now = Date.now();
  const roomId = event.roomId;
  const winner = event.winner;
  const failedSide = event.failedSide;

  if (roomId) {
    const rooms = await db.collection('rooms').where({ roomId }).limit(1).get();
    if (rooms.data.length) {
      await db.collection('rooms').doc(rooms.data[0]._id).update({
        data: {
          status: 'finished',
          result: { winner, failedSide, reportedBy: wxContext.OPENID, finishedAt: now },
          updatedAt: now
        }
      });
    }
  }

  await db.collection('battleRecords').add({
    data: {
      roomId: roomId || '',
      winner,
      failedSide,
      reportedBy: wxContext.OPENID,
      createdAt: now
    }
  });

  return { ok: true };
};
