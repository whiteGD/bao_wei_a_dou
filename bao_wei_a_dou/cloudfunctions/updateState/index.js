const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

/**
 * 低频状态快照上传。
 * 只保存每个玩家自己的最新快照，不保存历史，避免免费版云开发流量和写入压力过大。
 */
exports.main = async function main(event) {
  const wxContext = cloud.getWXContext();
  const roomId = event.roomId;
  const snapshot = event.snapshot || {};
  if (!roomId) throw new Error('缺少 roomId');

  const lookup = await db.collection('rooms').where({ roomId }).limit(1).get();
  if (!lookup.data.length) throw new Error('房间不存在');

  const room = lookup.data[0];
  const player = (room.players || []).find((item) => item.openid === wxContext.OPENID);
  if (!player) throw new Error('你不在这个房间中');

  const now = Date.now();
  const safeSnapshot = {
    side: player.side,
    wave: Number(snapshot.wave || 0),
    hp: Number(snapshot.hp || 0),
    gold: Number(snapshot.gold || 0),
    recruitCount: Number(snapshot.recruitCount || 0),
    waveActive: !!snapshot.waveActive,
    waveClock: Number(snapshot.waveClock || 0),
    spawnedInWave: Number(snapshot.spawnedInWave || 0),
    spawnClock: Number(snapshot.spawnClock || 0),
    generalSpawned: !!snapshot.generalSpawned,
    units: Array.isArray(snapshot.units) ? snapshot.units.slice(0, 40) : [],
    bench: Array.isArray(snapshot.bench) ? snapshot.bench.slice(0, 5) : [],
    tiles: Array.isArray(snapshot.tiles) ? snapshot.tiles.slice(0, 81) : [],
    enemies: Array.isArray(snapshot.enemies) ? snapshot.enemies.slice(0, 40) : [],
    stateHash: String(snapshot.stateHash || ''),
    updatedAt: now
  };

  await db.collection('rooms').doc(room._id).update({
    data: {
      [`states.${player.side}`]: safeSnapshot,
      updatedAt: now
    }
  });

  return { ok: true, updatedAt: now };
};
