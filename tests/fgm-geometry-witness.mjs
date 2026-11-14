// Исполнитель синтетических примеров C03.
const identifier = /^[a-z][a-z0-9_]*$/;

function readField(sample, point) {
  const value = sample(point);
  if (!Number.isFinite(value)) throw new Error("E_GEOM_VALUE");
  return value === 0 ? 0 : value;
}

function checkPoint(point) {
  if (!Array.isArray(point) || point.length !== 3 ||
      !Number.isFinite(point[0]) || !Number.isFinite(point[1]) ||
      !Number.isFinite(point[2])) throw new Error("E_GEOM_VALUE");
}

export function prepareMatter(contributions) {
  if (!Array.isArray(contributions) || contributions.length === 0) {
    throw new Error("E_CONTRIBUTION");
  }
  const ids = new Set();
  const ordered = Array.from(contributions, contribution => {
    const { id, material, priority, sample } = contribution ?? {};
    if (typeof id !== "string" || !identifier.test(id) || ids.has(id) ||
        typeof material !== "string" || !identifier.test(material) ||
        !Number.isSafeInteger(priority) || typeof sample !== "function") {
      throw new Error("E_CONTRIBUTION");
    }
    ids.add(id);
    return { id, material, priority, sample };
  });
  ordered.sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1));

  return point => {
    checkPoint(point);
    let value = Infinity;
    let winner = null;
    for (const contribution of ordered) {
      const sampled = readField(contribution.sample, point);
      value = Math.min(value, sampled);
      if (winner === null && sampled < 0) winner = contribution;
    }
    return { value, material: winner?.material ?? null, contributor: winner?.id ?? null };
  };
}

export function prepareSmoothUnion(options) {
  const { left, right, width, allowed, protectedRegion } = options ?? {};
  if (![left, right, allowed].every(sample => typeof sample === "function") ||
      !Number.isFinite(width) || width <= 0 ||
      (protectedRegion !== undefined && typeof protectedRegion !== "function")) {
    throw new Error("E_SMOOTH");
  }
  return point => {
    checkPoint(point);
    const a = readField(left, point);
    const b = readField(right, point);
    const hard = Math.min(a, b);
    const inside = -readField(allowed, point);
    const outsideProtection = protectedRegion === undefined
      ? width
      : readField(protectedRegion, point);
    const strength = Math.min(width, inside, outsideProtection);
    const difference = Math.abs(a - b);
    if (strength <= 0 || difference >= strength) return hard;

    const blend = 1 - difference / strength;
    const value = hard - (strength / 4) * blend * blend;
    if (!Number.isFinite(value)) throw new Error("E_GEOM_VALUE");
    return value === 0 ? 0 : value;
  };
}
