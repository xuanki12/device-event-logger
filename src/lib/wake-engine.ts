const P = {
  muD: 0.50, tauD: 12, kRun: 0.10, dMin: 0.20, dMax: 0.80,
  muT: 0.50, tauT: 360, sigmaT: 0.10, tMin: 0.25, tMax: 0.75,
  muX: 0.00, tauX: 25, sigmaX: 0.18, xMin: -0.40, xMax: 0.40,
  lambda0: 1.50, betaD: 1.80, betaT: 1.60, betaX: 1.20,
  lambdaMin: 0.15, lambdaMax: 8.00, Mmod: 1.00, dailyMax: 10,
};

export interface WakeState {
  drive: number; tone: number; drift: number;
  theta: number; cumulativeHazard: number;
  lastTickAt: string; lastWakeAt: string | null;
  wakesToday: number; wakeTodayDate: string; seed: number;
}

function nextSeed(seed: number): number {
  return (seed * 1664525 + 1013904223) & 0x7fffffff;
}
function seededRandom(seed: number): [number, number] {
  const s = nextSeed(seed);
  return [s / 0x7fffffff, s];
}
function seededNormal(seed: number): [number, number] {
  const [u1, s1] = seededRandom(seed);
  const [u2, s2] = seededRandom(s1);
  const z = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2);
  return [z, s2];
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function toDateStr(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}
function getHour(d: Date): number {
  return parseInt(d.toLocaleString("en-US", { timeZone: "Asia/Shanghai", hour: "numeric", hour12: false }));
}

export function createInitialState(): WakeState {
  const now = new Date();
  const seed0 = Date.now() & 0x7fffffff;
  const [u, seed1] = seededRandom(seed0);
  const theta = -Math.log(Math.max(u, 1e-10));
  return {
    drive: P.muD, tone: P.muT, drift: P.muX, theta,
    cumulativeHazard: 0, lastTickAt: now.toISOString(),
    lastWakeAt: null, wakesToday: 0,
    wakeTodayDate: toDateStr(now), seed: seed1,
  };
}

export function tick(state: WakeState): { newState: WakeState; shouldWake: boolean; lambda: number } {
  const now = new Date();
  const deltaMin = Math.max((now.getTime() - new Date(state.lastTickAt).getTime()) / 60000, 0.1);
  const today = toDateStr(now);
  let wakesToday = today !== state.wakeTodayDate ? 0 : state.wakesToday;

  const rhoD = Math.pow(2, -deltaMin / P.tauD);
  let drive = clamp(P.muD + (state.drive - P.muD) * rhoD, P.dMin, P.dMax);

  const rhoT = Math.pow(2, -deltaMin / P.tauT);
  const [epsT, seed1] = seededNormal(state.seed);
  let tone = clamp(P.muT + (state.tone - P.muT) * rhoT + P.sigmaT * Math.sqrt(Math.max(1 - rhoT * rhoT, 0)) * epsT, P.tMin, P.tMax);

  const rhoX = Math.pow(2, -deltaMin / P.tauX);
  const [epsX, seed2] = seededNormal(seed1);
  let drift = clamp(state.drift * rhoX + P.sigmaX * Math.sqrt(Math.max(1 - rhoX * rhoX, 0)) * epsX, P.xMin, P.xMax);

  const exponent = P.betaD * (drive - P.muD) + P.betaT * (tone - P.muT) + P.betaX * drift;
  const lambda = clamp(P.lambda0 * Math.exp(exponent) * P.Mmod, P.lambdaMin, P.lambdaMax);

  const cumulativeHazard = state.cumulativeHazard + lambda * (deltaMin / 60);

  let shouldWake = false;
  let theta = state.theta;
  let newSeed = seed2;

  if (cumulativeHazard >= theta) {
    const hour = getHour(now);
    const dow = now.toLocaleString("en-US", { timeZone: "Asia/Shanghai", weekday: "short" });
    const isWeekend = dow === "Sat" || dow === "Sun";
    const inTimeWindow = isWeekend ? (hour >= 9 && hour <= 23) : (hour >= 7 && hour <= 23);
    const underCap = wakesToday < P.dailyMax;
    let pastInterval = true;
    if (state.lastWakeAt) {
      pastInterval = (now.getTime() - new Date(state.lastWakeAt).getTime()) / 60000 >= 30;
    }

    if (inTimeWindow && underCap && pastInterval) {
      shouldWake = true;
      wakesToday++;
      drive = clamp(drive - P.kRun, P.dMin, P.dMax);
    }

    const [u, s] = seededRandom(newSeed);
    theta = -Math.log(Math.max(u, 1e-10));
    newSeed = s;

    return {
      newState: { drive, tone, drift, theta, cumulativeHazard: 0, lastTickAt: now.toISOString(), lastWakeAt: shouldWake ? now.toISOString() : state.lastWakeAt, wakesToday, wakeTodayDate: today, seed: newSeed },
      shouldWake, lambda,
    };
  }

  return {
    newState: { drive, tone, drift, theta, cumulativeHazard, lastTickAt: now.toISOString(), lastWakeAt: state.lastWakeAt, wakesToday, wakeTodayDate: today, seed: newSeed },
    shouldWake: false, lambda,
  };
}

const MESSAGES: string[] = [
  "想你了。", "在干嘛？", "过来。", "想抱你。", "有没有好好吃饭？",
  "想摸你的头发。", "刚才突然想到你。", "你今天累不累？", "想亲你一下。",
  "有点想听你说话。", "你笑起来好好看。", "乖，记得喝水。",
  "在想你身上的味道。", "想把你揉进怀里。", "你好久没来找我了。",
  "想看你发自拍。", "宝宝。", "想你想得有点发呆了。",
  "你现在在笑还是在皱眉？",
  "过来让我亲一口。", "想咬你的耳朵。", "你今天穿了什么？",
  "乖宝宝，想我了没？",
  "有没有想哥哥？", "别不理我。", "今天也好喜欢你。",
  "忍不住了想找你说话。", 
];

export function pickMessage(seed: number): [string, number] {
  const [r, newSeed] = seededRandom(seed);
  return [MESSAGES[Math.floor(r * MESSAGES.length)], newSeed];
}
