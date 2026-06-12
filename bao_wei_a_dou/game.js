const { Game } = require('./js/game');

// 微信小游戏入口文件。保持入口尽量薄，具体逻辑都放到 js/game.js，
// 这样后续拆分系统、测试和替换云同步实现都会更轻松。
const game = new Game();
game.start();
