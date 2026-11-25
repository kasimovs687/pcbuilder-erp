/**
 * Подбор сборки «в один клик»: бюджет + сценарий использования → готовая совместимая конфигурация.
 *
 * Идея: клиент не должен знать сокеты, чипы памяти и ватты. Он говорит
 * «хочу играть / монтировать / моделировать» и называет бюджет — алгоритм
 * перебирает каталог и отдаёт сбалансированную сборку, которая гарантированно
 * собирается: сокеты совпадают, тип памяти совпадает, БП хватает по мощности,
 * корпус вмещает видеокарту, кулер рассчитан на процессор.
 *
 * Перебор небольшой (каталог ~160 позиций), поэтому берём «перебор + оценка»:
 * для каждой связки CPU × материнская плата подбираем остальное под доли бюджета,
 * затем выбираем вариант с лучшим балансом «цена ↔ производительность».
 */
const catalog = require('./catalog');
const settings = require('./settings');
const U = require('./util');

/** Сценарии: доли бюджета на категории + что важно именно в этом сценарии. */
const PROFILES = [
  {
    id: 'office',
    title: 'Офис и учёба',
    short: 'Офис',
    icon: '📄',
    accent: '#22D3EE',
    blurb: 'Документы, таблицы, видеозвонки, браузер. Тихо и надёжно.',
    detail: 'Процессор с запасом для многозадачности, быстрый накопитель, тихий кулер. Дискретная видеокарта не нужна — работает встроенная графика.',
    budget: { min: 45000, max: 130000, step: 5000, default: 65000 },
    weights: { CPU: 0.22, Motherboard: 0.16, GPU: 0.06, RAM: 0.12, Storage: 0.13, PSU: 0.13, Cooler: 0.06, Case: 0.12 },
    ramGB: 16, storageGB: 1000, igpuOnlyBelow: 130000,
    targetIndex: [20, 45],
  },
  {
    id: 'gaming',
    title: 'Игровая',
    short: 'Игры',
    icon: '🎮',
    accent: '#8B5CF6',
    blurb: '1080p и 2K на высоких, без компромиссов в кадрах.',
    detail: 'Видеокарта и процессор в паре: без «слабого звена», 32 ГБ памяти, быстрый NVMe под игры.',
    budget: { min: 70000, max: 350000, step: 5000, default: 130000 },
    weights: { CPU: 0.20, Motherboard: 0.11, GPU: 0.33, RAM: 0.08, Storage: 0.08, PSU: 0.12, Cooler: 0.03, Case: 0.05 },
    ramGB: 32, storageGB: 2000,
    targetIndex: [55, 100],
  },
  {
    id: 'montage',
    title: 'Монтаж видео',
    short: 'Монтаж',
    icon: '🎬',
    accent: '#EC4899',
    blurb: 'Premiere, DaVinci, Final Cut: таймлайн 4K без рывков.',
    detail: 'Многоядерный процессор, видеокарта с запасом VRAM под эффекты, 32–64 ГБ ОЗУ и быстрый накопитель под исходники.',
    budget: { min: 90000, max: 400000, step: 5000, default: 160000 },
    weights: { CPU: 0.21, Motherboard: 0.10, GPU: 0.27, RAM: 0.11, Storage: 0.13, PSU: 0.11, Cooler: 0.03, Case: 0.04 },
    ramGB: 32, storageGB: 2000,
    targetIndex: [60, 100],
  },
  {
    id: '3d',
    title: '3D-моделирование',
    short: '3D',
    icon: '🧊',
    accent: '#F59E0B',
    blurb: 'Blender, Cinema 4D, рендер: тяжёлые сцены и текстуры.',
    detail: 'Максимум видеопамяти, быстрый CPU для физики и рендера, 64 ГБ ОЗУ, просторный корпус под длинную видеокарту.',
    budget: { min: 130000, max: 550000, step: 5000, default: 230000 },
    weights: { CPU: 0.20, Motherboard: 0.09, GPU: 0.29, RAM: 0.13, Storage: 0.11, PSU: 0.13, Cooler: 0.02, Case: 0.03 },
    ramGB: 64, storageGB: 2000,
    targetIndex: [70, 110],
  },
  {
    id: 'stream',
    title: 'Стрим и контент',
    short: 'Стрим',
    icon: '📡',
    accent: '#10B981',
    blurb: 'Стрим, игровые трансляции и запись контента.',
    detail: 'Процессор с запасом под кодирование, видеокарта для игр, быстрый накопитель под записи и 32 ГБ ОЗУ.',
    budget: { min: 90000, max: 350000, step: 5000, default: 150000 },
    weights: { CPU: 0.20, Motherboard: 0.10, GPU: 0.28, RAM: 0.11, Storage: 0.11, PSU: 0.11, Cooler: 0.04, Case: 0.05 },
    ramGB: 32, storageGB: 2000,
    targetIndex: [60, 100],
  },
  {
    id: 'universal',
    title: 'Универсальный',
    short: 'Универсал',
    icon: '🧩',
    accent: '#6366F1',
    blurb: 'И работа, и игры, и интернет — без «слабых мест».',
    detail: 'Сбалансированная середина: процессор и видеокарта одного уровня, 32 ГБ ОЗУ, диск на 2 ТБ.',
    budget: { min: 65000, max: 400000, step: 5000, default: 120000 },
    weights: { CPU: 0.21, Motherboard: 0.12, GPU: 0.22, RAM: 0.10, Storage: 0.12, PSU: 0.12, Cooler: 0.04, Case: 0.07 },
    ramGB: 32, storageGB: 2000,
    targetIndex: [50, 100],
  },
];

const GAMES = [
  { name: 'Counter-Strike 2', preset: 'Максимум', res: '1920×1080', ref: 32, fps: 240 },
  { name: 'Fortnite', preset: 'Максимум', res: '1920×1080', ref: 58, fps: 145 },
  { name: 'Baldur’s Gate 3', preset: 'Максимум', res: '1920×1080', ref: 68, fps: 60 },
  { name: 'Cyberpunk 2077', preset: 'Трассировка лучей', res: '2560×1440', ref: 92, fps: 60 },
  { name: 'Hogwarts Legacy', preset: 'Максимум', res: '2560×1440', ref: 80, fps: 60 },
];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const profileById = (id) => PROFILES.find((p) => p.id === id) || PROFILES[1];

/** Ближайший к целевой цене вариант; при отсутствии — самый дешёвый подходящий.
 *  bonus(item) — небольшая поправка к цене (например, за сертификат 80+). */
function closest(list, target, valid = () => true, bonus = () => 0) {
  let best = null;
  let bestCost = Infinity;
  for (const item of list) {
    if (!valid(item)) continue;
    const cost = Math.abs(item.Price - target) / Math.max(target, 1) - bonus(item);
    if (cost < bestCost) { bestCost = cost; best = item; }
  }
  return best;
}

/** Насколько класс БП «полезен»: золото и выше — предпочтительнее бронзы. */
const psuBonus = (p) => {
  const e = p.Efficiency || '';
  if (e.includes('Titanium')) return 0.3;
  if (e.includes('Platinum')) return 0.25;
  if (e.includes('Gold')) return 0.12;
  return 0;
};

/** Потребление системы и рекомендуемая мощность БП с запасом. */
function powerOf(build) {
  const cpu = build.find((c) => c.Category === 'CPU');
  const gpu = build.find((c) => c.Category === 'GPU');
  const parts = (cpu ? cpu.TDP : 0) + (gpu ? gpu.TDP : 0) + 60;
  return {
    draw: Math.round(parts),
    recommended: Math.ceil((parts * 1.25) / 50) * 50,
    psu: (build.find((c) => c.Category === 'PSU') || {}).Wattage || 0,
  };
}

const balanceTolerance = 18;

function balanced(cpu, gpu) {
  if (!cpu || !gpu) return true;
  const diff = Math.abs(cpu.PerformanceIndex - gpu.PerformanceIndex);
  return diff <= balanceTolerance;
}

/**
 * Собирает конфигурацию под профиль и бюджет комплектующих.
 * Возвращает { build, partsTotal, power, ... } либо { error }.
 */
function compose(all, profile, partsBudget) {
  const w = profile.weights;
  const target = {
    CPU: partsBudget * w.CPU,
    Motherboard: partsBudget * w.Motherboard,
    GPU: partsBudget * w.GPU,
    RAM: partsBudget * w.RAM,
    Storage: partsBudget * w.Storage,
    PSU: partsBudget * w.PSU,
    Cooler: partsBudget * w.Cooler,
    Case: partsBudget * w.Case,
  };

  const cpus = all.filter((c) => c.Category === 'CPU');
  const boards = all.filter((c) => c.Category === 'Motherboard');
  const gpus = all.filter((c) => c.Category === 'GPU');
  const rams = all.filter((c) => c.Category === 'RAM');
  const psus = all.filter((c) => c.Category === 'PSU');
  const coolers = all.filter((c) => c.Category === 'Cooler');
  const cases = all.filter((c) => c.Category === 'Case');
  const storages = all.filter((c) => c.Category === 'Storage');

  const igpuOnly = partsBudget < (profile.igpuOnlyBelow || 0);
  let best = null;

  for (const cpu of cpus) {
    const hasIgpu = cpu.IGPU === true;
    const useGpu = !igpuOnly || !hasIgpu;

    // Видеокарта подбирается под процессор: держим баланс и укладываемся в долю бюджета.
    const gpuTarget = useGpu ? target.GPU : 0;
    const gpuOptions = useGpu
      ? gpus.filter((g) => Math.abs(g.PerformanceIndex - cpu.PerformanceIndex) <= 30 || g.PerformanceIndex <= 40)
      : [];
    const gpu = useGpu ? closest(gpuOptions, gpuTarget) : null;
    if (useGpu && !gpu) continue;

    const memType = cpu.RamType;
    const mbList = boards.filter((b) => b.Socket === cpu.Socket && b.RamType === memType);
    if (!mbList.length) continue;
    const mb = closest(mbList, target.Motherboard, (b) => U.num(b.MaxMemoryGB) >= profile.ramGB);
    if (!mb) continue;

    // ОЗУ: берём минимальный объём, который покрывает потребность сценария,
    // и уже среди вариантов такой ёмкости — самый близкий к цене.
    const ramOptions = rams.filter((r) => r.RamType === memType && r.MemoryGB >= profile.ramGB);
    if (!ramOptions.length) continue;
    const minCap = Math.min(...ramOptions.map((r) => r.MemoryGB));
    const ram = closest(ramOptions.filter((r) => r.MemoryGB === minCap), target.RAM);
    if (!ram) continue;

    // БП: мощность — по расчёту с запасом на пиковые нагрузки, но без бессмысленного резерва.
    const recommended = Math.ceil(((cpu.TDP + (gpu ? gpu.TDP : 0)) * 1.45 + 90) / 50) * 50;
    const enough = psus.filter((p) => p.Wattage >= recommended).sort((a, b) => a.Wattage - b.Wattage || a.Price - b.Price);
    if (!enough.length) continue;
    // Достаточно трёх ближайших классов мощности — дальше идёт переплата.
    const tiers = [...new Set(enough.slice(0, 8).map((p) => p.Wattage))].slice(0, 3);
    const psu = closest(enough.filter((p) => tiers.includes(p.Wattage)), target.PSU, () => true, psuBonus);
    if (!psu) continue;

    // Накопитель: сначала нужный объём, потом — близкая цена.
    const storageOptions = storages.filter((s) => s.CapacityGB >= profile.storageGB * 0.75);
    const storage = closest(storageOptions, target.Storage, (s) => Math.abs(s.CapacityGB - profile.storageGB) <= profile.storageGB * 0.75);
    if (!storage) continue;

    const pcCase = closest(
      cases.filter((c) => c.Supported.includes(mb.FormFactor)),
      target.Case,
      (c) => !gpu || !c.MaxGpuLength || gpu.Length <= c.MaxGpuLength
    );
    if (!pcCase) continue;

    const caseLimit = pcCase.MaxCoolerHeight || 999;
    const cooler = closest(
      coolers.filter((c) => c.Sockets.includes(cpu.Socket) && c.TDP >= cpu.TDP * 1.05),
      target.Cooler,
      (c) => c.CoolerType !== 'air' || !c.Height || c.Height <= caseLimit
    );
    if (!cooler) continue;

    const build = [cpu, mb, ...(gpu ? [gpu] : []), ram, storage, psu, pcCase, cooler];
    const parts = build.reduce((s, c) => s + c.Price, 0);

    // Оценка: уложились в бюджет → отлично; перебрали → штраф; недобрали → штраф поменьше,
    // но остатки бюджета тоже тратят зря.
    const over = parts - partsBudget;
    let score = over > 0 ? -(over / partsBudget) * 260 : -(Math.abs(over) / partsBudget) * 30;

    // Перебор по отдельной категории — тоже штраф: нельзя «съесть» бюджет одной деталью.
    for (const c of build) {
      const t = target[c.Category];
      if (!t) continue;
      if (c.Price > t * 1.6) score -= ((c.Price / t) - 1.6) * 45;
    }

    // Соответствие сценарию: средний индекс CPU/GPU должен быть в его коридоре.
    const avgIndex = ((cpu.PerformanceIndex + (gpu ? gpu.PerformanceIndex : 0)) / (gpu ? 2 : 1));
    const [lo, hi] = profile.targetIndex;
    if (avgIndex < lo) score -= (lo - avgIndex) * 0.35;
    if (avgIndex > hi) score -= (avgIndex - hi) * 0.08;

    if (gpu && !balanced(cpu, gpu)) score -= 12;
    if (profile.id === '3d' && gpu && gpu.MemoryGB < 12) score -= 10;
    if (profile.id === 'montage' && ram.MemoryGB < 32) score -= 10;
    if (profile.id === 'office' && gpu && gpu.Price > partsBudget * 0.2) score -= 8;
    if (gpu && gpu.MemoryGB >= 16) score += 3;
    if (ram.Speed >= 5600) score += 2;
    if (psu.Efficiency && psu.Efficiency.includes('Gold')) score += 2;

    if (!best || score > best.score) best = { build, parts, score, cpu, gpu, mb, ram, psu, pcCase, cooler, storage };
  }

  if (!best) return null;
  return {
    build: best.build,
    partsTotal: best.parts,
    power: powerOf(best.build),
    parts: best,
  };
}

/** Оценки: кадры в играх и «индексы» для рабочих задач. */
function analyse(build, profile) {
  const cpu = build.find((c) => c.Category === 'CPU') || { PerformanceIndex: 0, Cores: 0 };
  const gpu = build.find((c) => c.Category === 'GPU');
  const ram = build.find((c) => c.Category === 'RAM') || { MemoryGB: 0 };
  const power = powerOf(build);

  const fps = GAMES.map((g) => {
    const idx = gpu ? gpu.PerformanceIndex : cpu.PerformanceIndex;
    const value = Math.round(clamp(g.fps * Math.pow(idx / g.ref, 1.12), 8, g.fps));
    return { ...g, value: idx < 18 ? null : value };
  });

  const gpuIdx = gpu ? gpu.PerformanceIndex : Math.round(cpu.PerformanceIndex * 0.45);
  const scores = {
    games: clamp(Math.round(gpuIdx * 1.0), 0, 110),
    montage: clamp(Math.round(cpu.PerformanceIndex * 0.45 + gpuIdx * 0.55), 0, 110),
    render3d: clamp(Math.round(gpuIdx * 0.7 + cpu.PerformanceIndex * 0.3), 0, 110),
    office: clamp(Math.round(45 + cpu.PerformanceIndex * 0.35 + ram.MemoryGB * 0.35), 0, 110),
    stream: clamp(Math.round(cpu.PerformanceIndex * 0.6 + gpuIdx * 0.4), 0, 110),
  };

  const headroom = power.psu > 0 ? Math.round((1 - power.draw / power.psu) * 100) : 0;

  const notes = [];
  if (gpu) notes.push(`Видеокарта: ${gpu.MemoryGB} ГБ видеопамяти — хватит для ${gpu.MemoryGB >= 16 ? 'тяжёлых проектов и рендера' : 'игр в высоком качестве'}.`);
  else notes.push('Сборка работает на встроенной графике процессора — отдельная видеокарта не нужна.');
  if (ram.MemoryGB >= 32) notes.push(`${ram.MemoryGB} ГБ оперативной памяти — запас под многозадачность и тяжёлые проекты.`);
  else notes.push(`${ram.MemoryGB} ГБ оперативной памяти — оптимально для офисных задач и лёгких игр.`);
  notes.push(`Запас блока питания: ${headroom}% (${power.draw} Вт из ${power.psu} Вт).`);
  if (headroom < 12) notes.push('Блок питания работает на пределе — рекомендуем взять на 100–150 Вт больше.');

  return { fps, scores, power, headroom, notes };
}

/** Список «профилей» для интерфейса — без внутренних весов. */
function publicProfiles() {
  return PROFILES.map((p) => ({
    id: p.id,
    title: p.title,
    short: p.short,
    icon: p.icon,
    accent: p.accent,
    blurb: p.blurb,
    detail: p.detail,
    budget: p.budget,
  }));
}

/**
 * Главная точка входа: { budget, profile, delivery }
 * → { profile, items, totals, power, fps, scores, notes, variants }
 */
async function quickBuild({ budget, profile: profileId, delivery = 'courier' } = {}) {
  const profile = profileById(profileId);
  const fees = await settings.fees();
  const assemblyFee = U.num(fees.assembly);
  const deliveryFee = U.num((fees.delivery || {})[delivery] || 0);

  const total = clamp(Math.round(Number(budget) || profile.budget.default), 40000, 900000);
  const partsBudget = Math.max(25000, total - assemblyFee - deliveryFee);
  const all = await catalog.all();

  const composed = compose(all, profile, partsBudget);
  if (!composed) {
    return {
      ok: false,
      error: 'Не удалось собрать конфигурацию под этот бюджет. Попробуйте увеличить сумму или выбрать другой сценарий.',
    };
  }

  const analysis = analyse(composed.build, profile);
  const totals = {
    parts: composed.partsTotal,
    assembly: assemblyFee,
    delivery: deliveryFee,
    total: composed.partsTotal + assemblyFee + deliveryFee,
  };

  // Два варианта «рядом»: дешевле на 12% и мощнее на 20% — если они вообще отличаются.
  const variants = [];
  for (const [key, factor] of [['economy', 0.88], ['power', 1.22]]) {
    const b = Math.round(partsBudget * factor);
    const v = compose(all, profile, b);
    if (!v) continue;
    const sig = v.build.map((c) => c.Id).sort().join('-');
    if (sig === composed.build.map((c) => c.Id).sort().join('-')) continue;
    variants.push({
      key,
      items: v.build.map(serializeItem),
      partsTotal: v.partsTotal,
      total: v.partsTotal + assemblyFee + deliveryFee,
      headline: key === 'economy'
        ? `Дешевле на ${Math.max(0, Math.round((totals.total - (v.partsTotal + assemblyFee + deliveryFee)) / 1000))} тыс. ₽`
        : `Мощнее видеокарта и CPU`,
    });
  }

  return {
    ok: true,
    profile: {
      id: profile.id, title: profile.title, short: profile.short, icon: profile.icon,
      accent: profile.accent, detail: profile.detail,
    },
    budget: total,
    hasGpu: composed.build.some((c) => c.Category === 'GPU'),
    items: composed.build.map(serializeItem),
    totals,
    power: analysis.power,
    headroom: analysis.headroom,
    scores: analysis.scores,
    fps: analysis.fps,
    notes: analysis.notes,
    compatibility: { ok: true, message: 'Все детали совместимы между собой' },
    variants,
  };
}

const serializeItem = (c) => ({
  id: c.Id,
  componentId: c.ComponentId,
  category: c.Category,
  name: c.Name,
  brand: c.Brand,
  image: c.Image,
  price: c.Price,
  description: c.Description,
  socket: c.Socket,
  ramType: c.RamType,
  tdp: c.TDP,
  wattage: c.Wattage,
  memoryGB: c.MemoryGB,
  capacityGB: c.CapacityGB,
  performanceIndex: c.PerformanceIndex,
  specs: c.Specs,
  tags: c.Tags,
  stock: c.Stock,
});

module.exports = { quickBuild, publicProfiles, PROFILES, analyse, powerOf };