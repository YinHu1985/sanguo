const MAJOR_CITIES = new Set(["luoyang", "changan", "xuchang", "ye", "chengdu", "xiangyang", "jianye"]);
const REGIONAL_CITIES = new Set(["ji", "beiping", "xiangping", "nanpi", "pingyuan", "jinan", "beihai", "puyang", "chenliu", "xuzhou",
  "shouchun", "runan", "wan", "jiangling", "changsha", "wu", "kuaiji", "yuzhang", "hanzhong", "tianshui", "wuwei", "jincheng", "jiangzhou", "jiaozhi"]);
const bounded = (value, min, max, fallback) => Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;

/** The default is architectural scale, not ownership, troop count or officer presence. */
export function normalizeCityDefense(city) {
  const wallLevel = bounded(city.wallLevel, 1, 3, MAJOR_CITIES.has(city.id) ? 3 : REGIONAL_CITIES.has(city.id) ? 2 : 1);
  return {
    wallLevel,
    defense: bounded(city.defense, 0, 100, 100),
    wallProgress: wallLevel === 3 ? 0 : bounded(city.wallProgress, 0, 99, 0)
  };
}

/** Repairs and architectural expansion are separate: repairing damage never grants upgrade progress. */
export function applyWallDevelopment(city, work) {
  Object.assign(city, normalizeCityDefense(city));
  const before = { wallLevel: city.wallLevel, defense: city.defense, wallProgress: city.wallProgress };
  const labor = Math.max(0, Math.floor(Number.isFinite(work) ? work : 0));
  const repair = Math.min(labor, 100 - city.defense);
  city.defense += repair;
  // An order begun on damaged walls is a repair order, even if its spare labor could be used for expansion.
  if (before.defense === 100 && city.wallLevel < 3) {
    city.wallProgress += labor;
    while (city.wallProgress >= 100 && city.wallLevel < 3) {
      city.wallProgress -= 100;
      city.wallLevel += 1;
    }
    if (city.wallLevel === 3) city.wallProgress = 0;
  }
  return { defenseGain: city.defense - before.defense, progressGain: before.defense === 100 && before.wallLevel < 3 ? labor : 0,
    levelGain: city.wallLevel - before.wallLevel, wallLevel: city.wallLevel, defense: city.defense, wallProgress: city.wallProgress };
}
