import { Game } from './core/Game';
import { TitleScene } from './scenes/TitleScene';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const game = new Game(canvas);
game.changeScene(new TitleScene(game));
game.start();
