import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareFgm0 } from "./fgm-0-witness.mjs";
import {
  canonicalPoint, cellContaining, cellToObject, childCell, chunkAddress,
  createPlacement, objectToCell, pointToObject,
} from "./fgm-space-witness.mjs";

function cell(level, x, y, z) {
  return { level, index: [BigInt(x), BigInt(y), BigInt(z)] };
}

function pointIn(address, exponent, x, y, z) {
  return canonicalPoint(address, { exponent, numerators: [BigInt(x), BigInt(y), BigInt(z)] });
}

const identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const quarterTurn = [[0, -1, 0], [1, 0, 0], [0, 0, 1]];

test("дочерние кубы делят родительский куб по трём осям", () => {
  const parent = cell(1, -2, 1, 0);
  const midpoint = pointIn(parent, 1, 1, 1, 1);
  assert.deepEqual(childCell(parent, [1, 0, 1]), cell(2, -3, 2, 1));
  assert.deepEqual(childCell(parent, [0, 1, 0]), cell(2, -4, 3, 0));
  assert.deepEqual(pointIn(childCell(parent, [1, 0, 1]), 0, 0, 1, 0), midpoint);
});

test("соседние кубы и разные уровни дают один адрес общей точки", () => {
  const coarse = pointIn(cell(0, -1, 0, 0), 2, 4, 2, 2);
  const fine = pointIn(cell(1, 0, 1, 0), 0, 0, 0, 1);
  assert.deepEqual(coarse, { exponent: 1, numerators: [0n, 1n, 1n] });
  assert.deepEqual(fine, coarse);
  assert.deepEqual(pointToObject(fine, 3), [0, 1.5, 1.5]);
});

test("восемь кубов имеют один канонический адрес общей вершины", () => {
  const origin = { exponent: 0, numerators: [0n, 0n, 0n] };
  for (const x of [-1, 0]) {
    for (const y of [-1, 0]) {
      for (const z of [-1, 0]) {
        assert.deepEqual(pointIn(cell(2, x, y, z), 0, -x, -y, -z), origin);
      }
    }
  }
  assert.deepEqual(pointIn(cell(-0, 0, 0, 0), -0, 0, 0, 0), origin);
  assert.deepEqual(cellContaining(origin, -0), cell(0, 0, 0, 0));
});

test("владелец общей грани определяется полуоткрытым кубом", () => {
  const onFace = pointIn(cell(0, -1, 0, 0), 2, 4, 2, 2);
  assert.deepEqual(cellContaining(onFace, 0), cell(0, 0, 0, 0));
  assert.deepEqual(cellContaining(onFace, 1), cell(1, 0, 1, 1));
  const belowZero = pointIn(cell(0, -1, -1, -1), 2, 3, 3, 3);
  assert.deepEqual(cellContaining(belowZero, 0), cell(0, -1, -1, -1));
  assert.deepEqual(cellContaining(belowZero, 3), cell(3, -2, -2, -2));
});

test("отрицательные адреса чанков дают неотрицательный индекс внутри чанка", () => {
  assert.deepEqual(chunkAddress(cell(2, -5, -1, 4), 2n), {
    level: 2, index: [-3n, -1n, 2n], offset: [1n, 1n, 0n],
  });
  const left = cell(2, -1, 0, 0);
  const right = cell(2, 0, 0, 0);
  assert.notDeepEqual(chunkAddress(left, 2n).index, chunkAddress(right, 2n).index);
  assert.deepEqual(pointIn(left, 1, 2, 1, 1), pointIn(right, 1, 0, 1, 1));
  assert.deepEqual(chunkAddress(cell(-0, 0, 0, 0), 2n), {
    level: 0, index: [0n, 0n, 0n], offset: [0n, 0n, 0n],
  });
});

test("точный адрес различает соседние целые за пределами точности double", () => {
  const large = 2n ** 60n;
  const left = cell(0, large, 0, 0);
  const right = cell(0, large + 1n, 0, 0);
  assert.notDeepEqual(pointIn(left, 0, 0, 0, 0), pointIn(right, 0, 0, 0, 0));
  assert.deepEqual(pointIn(left, 0, 1, 0, 0), pointIn(right, 0, 0, 0, 0));
});

test("большой числитель на глубоком уровне даёт конечную координату выборки", () => {
  const address = cell(1023, (1n << 1024n) + 1n, 0, 0);
  const origin = pointIn(address, 0, 0, 0, 0);
  assert.equal(origin.exponent, 1023);
  assert.deepEqual(pointToObject(origin, 1), [2, 0, 0]);
  assert.deepEqual(cellToObject(address, [0, 0, 0], 1), [2, 0, 0]);
});

test("координаты куба обратимы при переносе, повороте и масштабе экземпляра", () => {
  const address = cell(1, -1, 2, 3);
  const normalized = [0.25, 0.5, 0.75];
  const placement = createPlacement({ translation: [10, -4, 7], rotation: quarterTurn, scale: 2 });
  const object = cellToObject(address, normalized, 4);
  assert.deepEqual(object, [-1.5, 5, 7.5]);
  assert.deepEqual(placement.toWorld(object), [0, -7, 22]);
  assert.deepEqual(placement.toObject([0, -7, 22]), object);
  assert.deepEqual(objectToCell(address, placement.toObject([0, -7, 22]), 4), normalized);
});

test("обратное преобразование сохраняет точку при наклонном повороте", () => {
  const c = Math.sqrt(3) / 2;
  const placement = createPlacement({
    translation: [4, -7, 0.25], rotation: [[c, -0.5, 0], [0.5, c, 0], [0, 0, 1]], scale: 0.7,
  });
  const object = [-1.25, 5, 7.5];
  const back = placement.toObject(placement.toWorld(object));
  for (const [axis, expected] of object.entries()) {
    assert.ok(Math.abs(back[axis] - expected) < 1e-12);
  }
});

test("отражение, сдвиг осей и неположительный масштаб отклоняются", () => {
  const translation = [0, 0, 0];
  for (const [rotation, scale] of [
    [[[-1, 0, 0], [0, 1, 0], [0, 0, 1]], 1],
    [[[1, 1, 0], [0, 1, 0], [0, 0, 1]], 1],
    [identity, 0],
  ]) {
    assert.throws(() => createPlacement({ translation, rotation, scale }), { message: "E_SPACE_TRANSFORM" });
  }
});

test("выборка за границей куба и недопустимый размер чанка отклоняются", () => {
  const address = cell(0, 0, 0, 0);
  assert.throws(() => pointIn(address, 1, 3, 0, 0), { message: "E_SPACE_POINT" });
  assert.throws(() => pointIn(cell(-1, 0, 0, 0), 0, 0, 0, 0), { message: "E_SPACE_ADDRESS" });
  assert.throws(() => chunkAddress(address, 0n), { message: "E_SPACE_ADDRESS" });
});

function placedBox(id, halfSize, center) {
  return [
    { id: id + "_size", op: "constant", type: "vec3", value: halfSize },
    { id: id + "_box", op: "box", halfSize: id + "_size" },
    { id: id + "_center", op: "constant", type: "vec3", value: center },
    { id, op: "translate", field: id + "_box", offset: id + "_center" },
  ];
}

test("дерево на 16 клетках имеет общую древесину и общую границу с воздухом", () => {
  const sample = prepareFgm0({
    version: "fgm-0",
    nodes: [
      ...placedBox("trunk", [0.25, 0.25, 1.75], [1, 1, 1.75]),
      ...placedBox("branch", [0.5, 0.125, 0.125], [1.375, 1, 2.5]),
      { id: "tree", op: "union", left: "trunk", right: "branch" },
      { id: "wood", op: "material", field: "tree", kind: "wood" },
    ],
    root: "wood",
  });
  const addresses = [];
  for (let x = 0; x < 2; x++) {
    for (let y = 0; y < 2; y++) {
      for (let z = 0; z < 4; z++) addresses.push(cell(0, x, y, z));
    }
  }
  const centers = addresses.map(address => pointIn(address, 1, 1, 1, 1));
  assert.equal(new Set(centers.map(({ numerators }) => numerators.join(","))).size, 16);
  assert.deepEqual(centers.map(point => cellContaining(point, 0)), addresses);

  const trunkLeft = pointIn(cell(0, 0, 1, 2), 1, 2, 0, 1);
  const trunkRight = pointIn(cell(1, 2, 2, 5), 0, 0, 0, 0);
  assert.deepEqual(trunkLeft, trunkRight);
  const trunk = pointToObject(trunkLeft, 1);
  assert.deepEqual(trunk, [1, 1, 2.5]);
  assert.deepEqual(sample(trunk), { value: -0.25, material: "wood" });
  const branch = pointToObject(pointIn(cell(0, 1, 1, 2), 1, 1, 0, 1), 1);
  assert.deepEqual(sample(branch), { value: -0.125, material: "wood" });
  const empty = pointToObject(pointIn(cell(0, 0, 0, 3), 1, 1, 1, 1), 1);
  assert.equal(sample(empty).value, 0.25);

  const sideLeft = pointIn(cell(0, 0, 1, 1), 2, 4, 1, 2);
  const sideRight = pointIn(cell(0, 1, 1, 1), 2, 0, 1, 2);
  assert.deepEqual(sideLeft, sideRight);
  const side = pointToObject(sideLeft, 1);
  assert.deepEqual(side, [1, 1.25, 1.5]);
  assert.equal(sample(side).value, 0);
  assert.equal(sample([1, 1.125, 1.5]).value, -0.125);
  assert.equal(sample([1, 1.375, 1.5]).value, 0.125);

  const placement = createPlacement({ translation: [4, -7, 0.25], rotation: quarterTurn, scale: 2 });
  assert.deepEqual(placement.toWorld(trunk), [2, -5, 5.25]);
  assert.deepEqual(placement.toWorld(pointToObject(trunkRight, 1)), [2, -5, 5.25]);
  assert.deepEqual(sample(placement.toObject([2, -5, 5.25])), sample(trunk));
});

test("соседние участки и уровни выбирают содержимое одного снимка", () => {
  const program = {
    version: "fgm-0",
    nodes: [
      { id: "radius", op: "parameter", type: "length" },
      { id: "body", op: "sphere", radius: "radius" },
    ],
    root: "body",
  };
  const expanded = prepareFgm0(program, { parameters: { radius: 1.25 } });
  const contracted = prepareFgm0(program, { parameters: { radius: 0.75 } });
  const left = pointIn(cell(0, 0, 0, 0), 0, 1, 0, 0);
  const right = pointIn(cell(1, 2, 0, 0), 0, 0, 0, 0);

  assert.deepEqual(left, right);
  assert.deepEqual(expanded(pointToObject(left, 1)), { value: -0.25 });
  assert.deepEqual(contracted(pointToObject(left, 1)), { value: 0.25 });
  assert.deepEqual(contracted(pointToObject(right, 1)), { value: 0.25 });
  assert.deepEqual(expanded(pointToObject(right, 1)), { value: -0.25 });
});

test("нулевая грань внутри древесины отличается от внешней границы", () => {
  const sample = prepareFgm0({
    version: "fgm-0",
    nodes: [
      ...placedBox("left", [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]),
      ...placedBox("right", [0.5, 0.5, 0.5], [1.5, 0.5, 0.5]),
      { id: "shape", op: "union", left: "left", right: "right" },
    ],
    root: "shape",
  });
  const seam = pointIn(cell(0, 0, 0, 0), 1, 2, 1, 1);
  assert.deepEqual(seam, pointIn(cell(0, 1, 0, 0), 1, 0, 1, 1));
  assert.equal(sample(pointToObject(seam, 1)).value, 0);
  assert.equal(sample([0.875, 0.5, 0.5]).value, -0.125);
  assert.equal(sample([1.125, 0.5, 0.5]).value, -0.125);

  assert.equal(sample([2, 0.5, 0.5]).value, 0);
  assert.equal(sample([1.875, 0.5, 0.5]).value, -0.125);
  assert.equal(sample([2.125, 0.5, 0.5]).value, 0.125);
});
