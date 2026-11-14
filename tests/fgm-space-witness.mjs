// Исполнитель синтетических примеров координат C02.
const maxExponent = 1023;
const rotationTolerance = 1e-12;

function require(condition, code) {
  if (!condition) throw new Error(code);
}

function isExponent(value) {
  return Number.isInteger(value) && value >= 0 && value <= maxExponent;
}

function vector3(value, component) {
  return Array.isArray(value) && value.length === 3 && [...value].every(component);
}

function integer3(value) {
  return vector3(value, entry => typeof entry === "bigint");
}

function checkCell(cell) {
  require(isExponent(cell?.level) && integer3(cell.index), "E_SPACE_ADDRESS");
}

function checkPoint(point) {
  require(isExponent(point?.exponent) && integer3(point.numerators), "E_SPACE_POINT");
}

function checkSide(side) {
  require(Number.isFinite(side) && side > 0, "E_SPACE_TRANSFORM");
}

function floorDivide(value, divisor) {
  const quotient = value / divisor;
  return value % divisor < 0n ? quotient - 1n : quotient;
}

function normalizeZero(value) {
  return value === 0 ? 0 : value;
}

export function childCell(cell, bits) {
  checkCell(cell);
  require(isExponent(cell.level + 1) && vector3(bits, bit => bit === 0 || bit === 1), "E_SPACE_ADDRESS");
  return { level: cell.level + 1, index: cell.index.map((index, axis) => 2n * index + BigInt(bits[axis])) };
}

export function canonicalPoint(cell, local) {
  checkCell(cell);
  checkPoint(local);
  let exponent = normalizeZero(cell.level + local.exponent);
  require(isExponent(exponent), "E_SPACE_POINT");
  const denominator = 1n << BigInt(local.exponent);
  require(local.numerators.every(value => value >= 0n && value <= denominator), "E_SPACE_POINT");

  let numerators = cell.index.map((index, axis) => index * denominator + local.numerators[axis]);
  while (exponent > 0 && numerators.every(value => value % 2n === 0n)) {
    numerators = numerators.map(value => value / 2n);
    exponent--;
  }
  return { exponent, numerators };
}

export function cellContaining(point, level) {
  checkPoint(point);
  require(isExponent(level), "E_SPACE_ADDRESS");
  const index = point.numerators.map(value => {
    if (level >= point.exponent) return value << BigInt(level - point.exponent);
    return floorDivide(value, 1n << BigInt(point.exponent - level));
  });
  return { level: normalizeZero(level), index };
}

export function chunkAddress(cell, cellsPerSide) {
  checkCell(cell);
  require(typeof cellsPerSide === "bigint" && cellsPerSide > 0n, "E_SPACE_ADDRESS");
  const index = cell.index.map(value => floorDivide(value, cellsPerSide));
  const offset = cell.index.map((value, axis) => value - index[axis] * cellsPerSide);
  return { level: normalizeZero(cell.level), index, offset };
}

function finiteResult(point) {
  require(point.every(Number.isFinite), "E_SPACE_NUMERIC");
  return point.map(normalizeZero);
}

function dyadicNumber(numerator, exponent) {
  const denominator = 1n << BigInt(exponent);
  const whole = numerator / denominator;
  const remainder = numerator % denominator;
  return Number(whole) + Number(remainder) / Number(denominator);
}

function samplingSide(level, side) {
  checkSide(side);
  const step = side * 2 ** -level;
  require(step > 0, "E_SPACE_NUMERIC");
  return step;
}

export function pointToObject(point, side) {
  checkPoint(point);
  checkSide(side);
  return finiteResult(point.numerators.map(value => side * dyadicNumber(value, point.exponent)));
}

export function cellToObject(cell, point, side) {
  checkCell(cell);
  require(vector3(point, value => Number.isFinite(value) && value >= 0 && value <= 1), "E_SPACE_POINT");
  checkSide(side);
  const fraction = 2 ** -cell.level;
  return finiteResult(cell.index.map((index, axis) =>
    side * (dyadicNumber(index, cell.level) + fraction * point[axis])));
}

export function objectToCell(cell, point, side) {
  checkCell(cell);
  require(vector3(point, Number.isFinite), "E_SPACE_POINT");
  const step = samplingSide(cell.level, side);
  return finiteResult(point.map((value, axis) => value / step - Number(cell.index[axis])));
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function createPlacement(transform) {
  const { translation, rotation, scale } = transform ?? {};
  require(vector3(translation, Number.isFinite) &&
    vector3(rotation, row => vector3(row, Number.isFinite)) &&
    Number.isFinite(scale) && scale > 0, "E_SPACE_TRANSFORM");
  const origin = [...translation];
  const rows = rotation.map(row => [...row]);
  const columns = rows.map((_, axis) => rows.map(row => row[axis]));
  const near = (value, expected) => Math.abs(value - expected) <= rotationTolerance;
  const orthonormal = rows.every((row, i) => rows.every((other, j) => near(dot(row, other), i === j ? 1 : 0)));
  const determinant = dot(rows[0], cross(rows[1], rows[2]));
  require(orthonormal && near(determinant, 1), "E_SPACE_TRANSFORM");

  return {
    toWorld(point) {
      require(vector3(point, Number.isFinite), "E_SPACE_POINT");
      return finiteResult(rows.map((row, axis) => origin[axis] + scale * dot(row, point)));
    },
    toObject(point) {
      require(vector3(point, Number.isFinite), "E_SPACE_POINT");
      const shifted = finiteResult(point.map((value, axis) => (value - origin[axis]) / scale));
      return finiteResult(columns.map(column => dot(column, shifted)));
    },
  };
}
