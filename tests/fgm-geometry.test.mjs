import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareFgm0 } from "./fgm-0-witness.mjs";
import { prepareMatter, prepareSmoothUnion } from "./fgm-geometry-witness.mjs";

function box(nodes, name, size) {
  nodes.push(
    { id: name + "_size", op: "constant", type: "vec3", value: size },
    { id: name, op: "box", halfSize: name + "_size" },
  );
}

function evaluate(nodes, root = nodes.at(-1).id) {
  const sample = prepareFgm0({ version: "fgm-0", nodes, root });
  return point => sample(point).value;
}

function boxField(size) {
  const nodes = [];
  box(nodes, "body", size);
  return evaluate(nodes);
}

function cutBox(size, cutout) {
  const nodes = [];
  box(nodes, "body", size);
  box(nodes, "cutout", cutout);
  nodes.push({ id: "shape", op: "subtract", left: "body", right: "cutout" });
  return evaluate(nodes);
}

const rock = { id: "rock", material: "stone", priority: 10, sample: boxField([3, 3, 3]) };
const beam = { id: "beam", material: "metal", priority: 20, sample: boxField([1, 1, 1]) };
const center = [0, 0, 0];

test("перекрытие выбирает материал по приоритету и сохраняет поле объединения", () => {
  const forward = prepareMatter([rock, beam]);
  const reverse = prepareMatter([beam, rock]);
  assert.deepEqual(forward(center), { value: -3, material: "metal", contributor: "beam" });
  assert.deepEqual(reverse(center), forward(center));
  assert.deepEqual(forward([1, 0, 0]), { value: -2, material: "stone", contributor: "rock" });
  assert.deepEqual(forward([3, 0, 0]), { value: 0, material: null, contributor: null });
  assert.deepEqual(forward([4, 0, 0]), { value: 1, material: null, contributor: null });
});

test("равный приоритет разрешается постоянным идентификатором вклада", () => {
  const equal = { ...beam, priority: rock.priority };
  for (const contributions of [[rock, equal], [equal, rock]]) {
    assert.equal(prepareMatter(contributions)(center).contributor, "beam");
  }
});

test("удаление вклада при наложении оставляет камень, явный вырез оставляет полость", () => {
  const hollowRock = { ...rock, sample: cutBox([3, 3, 3], [1, 1, 1]) };
  assert.equal(prepareMatter([hollowRock, beam])(center).material, "metal");
  assert.deepEqual(prepareMatter([rock])(center), { value: -3, material: "stone", contributor: "rock" });
  assert.deepEqual(prepareMatter([hollowRock])(center), { value: 1, material: null, contributor: null });
});

test("точная стена сохраняет плоскость, угол и сквозной проём", () => {
  const wall = { ...rock, sample: cutBox([2, 2, 1], [0.5, 0.5, 2]) };
  const sample = prepareMatter([wall]);
  for (const z of [-1, -0.5, 0, 0.5, 1]) assert.equal(sample([0, 0, z]).value, 0.5);
  for (const y of [0, 1, 2]) assert.equal(sample([2, y, 0]).value, 0);
  assert.equal(sample([1.75, 1.75, 0]).value, -0.25);
  assert.equal(sample([2.25, 2.25, 0]).value, 0.25);
});

test("смена материала сама по себе сохраняет форму и правило заполненного прохода", () => {
  const wall = { ...rock, sample: cutBox([2, 2, 1], [0.5, 0.5, 2]) };
  const stone = prepareMatter([wall]);
  const metal = prepareMatter([{ ...wall, material: "metal" }]);
  for (const point of [center, [1, 0, 0], [3, 0, 0]]) {
    assert.equal(stone(point).value, metal(point).value);
  }
  const blocks = sample => sample([1, 0, 0]).value < 0 && sample(center).value >= 0;
  assert.equal(blocks(stone), true);
  assert.equal(blocks(metal), true);
  assert.equal(metal([1, 0, 0]).material, "metal");
});

test("явное сглаживание смягчает стык только внутри разрешённой зоны", () => {
  const sphere = sign => evaluate([
    { id: "radius", op: "constant", type: "length", value: 1 },
    { id: "body", op: "sphere", radius: "radius" },
    { id: "offset", op: "constant", type: "vec3", value: [sign * 0.75, 0, 0] },
    { id: "side", op: "translate", field: "body", offset: "offset" },
  ]);
  const left = sphere(-1);
  const right = sphere(1);
  const allowed = boxField([2, 2, 1]);
  const protectedRegion = boxField([0.25, 0.25, 0.25]);
  const smooth = prepareSmoothUnion({ left, right, width: 0.5, allowed, protectedRegion });
  const hard = point => Math.min(left(point), right(point));
  assert.equal(hard([0, 0.75, 0]) > 0, true);
  assert.equal(smooth([0, 0.75, 0]) < 0, true);
  for (const point of [center, [0, 0.25, 0], [0, 0, 1], [0, 0, 1.125]]) {
    assert.equal(smooth(point), hard(point));
  }
  assert.ok(Math.abs(smooth([0, 0.25 + 1e-6, 0]) - hard([0, 0.25 + 1e-6, 0])) < 1e-6);
  assert.ok(Math.abs(smooth([0, 0, 1 - 1e-6]) - hard([0, 0, 1 - 1e-6])) < 1e-6);
});

test("проверяются идентификаторы, приоритет, параметры сглаживания и конечность полей", () => {
  assert.throws(() => prepareMatter([]), { message: "E_CONTRIBUTION" });
  assert.throws(() => prepareMatter([rock, { ...beam, id: rock.id }]), { message: "E_CONTRIBUTION" });
  assert.throws(() => prepareMatter([{ ...rock, priority: Infinity }]), { message: "E_CONTRIBUTION" });
  assert.throws(() => prepareMatter([{ ...rock, sample: () => NaN }])(center), { message: "E_GEOM_VALUE" });
  const smooth = { left: rock.sample, right: beam.sample, width: 0, allowed: rock.sample };
  assert.throws(() => prepareSmoothUnion(null), { message: "E_SMOOTH" });
  assert.throws(() => prepareSmoothUnion(smooth), { message: "E_SMOOTH" });
  assert.throws(() => prepareSmoothUnion({ ...smooth, width: 1, allowed: () => Infinity })(center),
    { message: "E_GEOM_VALUE" });
});
