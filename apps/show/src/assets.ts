import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "assets");

/** Absolute paths to every asset the engine draws or plays. Ported from KOTH `bot/assets`. */
export const ASSETS = {
  rigs: {
    background: path.join(ROOT, "rigs", "Background Scene.svg"),
    boris: path.join(ROOT, "rigs", "Boris.svg"),
    chairs: path.join(ROOT, "rigs", "Chairs.svg"),
    deskNoChair: path.join(ROOT, "rigs", "Desk no chair.svg"),
    desk: path.join(ROOT, "rigs", "Desk.svg"),
    pavel: path.join(ROOT, "rigs", "Pavel.svg"),
  },
  fonts: {
    display: path.join(ROOT, "fonts", "Animals are like people.ttf"),
    gamertag: path.join(ROOT, "fonts", "PatrickHand-Regular.ttf"),
  },
  introMp3: path.join(ROOT, "intro.mp3"),
  outroMp3: path.join(ROOT, "outro.mp3"),
  // The new Clan Wars intro (3840x2160, spec §11.1); outro-screen.png is ported unchanged from KOTH.
  introScreen: path.join(ROOT, "intro-screen.png"),
  outroScreen: path.join(ROOT, "outro-screen.png"),
};
