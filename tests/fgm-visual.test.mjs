import assert from "node:assert/strict";
import { test } from "node:test";
import { preparePanel, presentPanel } from "./fgm-visual-witness.mjs";

const program = {
  version: "fgm-0",
  nodes: [
    { id: "outer_size", op: "constant", type: "vec3", value: [2, 2, 1] },
    { id: "outer", op: "box", halfSize: "outer_size" },
    { id: "hole_size", op: "parameter", type: "vec3" },
    { id: "hole", op: "box", halfSize: "hole_size" },
    { id: "shape", op: "subtract", left: "outer", right: "hole" },
    { id: "panel", op: "material", field: "shape", kind: "metal" },
  ],
  root: "panel",
};

const model = {
  program,
  bindings: { parameters: { hole_size: [0.5, 0.5, 2] } },
  rules: { interiorBlocks: true },
};
const matte = { version: 1, seed: 17, color: "#465762", emission: 0 };
const luminous = { version: 1, seed: 23, color: "#7cebc8", emission: 4 };
const front = { camera: [0, 0, 5], resolution: [800, 600], lod: 1 };
const side = { camera: [5, 0, 0], resolution: [1920, 1080], lod: 3 };

test("два профиля и два вида сохраняют семантические выборки панели", () => {
  const points = [[0, 0, -1], [0, 0, 0], [0, 0, 1], [1, 0, 0], [3, 0, 0]];
  const expected = [
    { value: 0.5, material: "metal", blocks: false },
    { value: 0.5, material: "metal", blocks: false },
    { value: 0.5, material: "metal", blocks: false },
    { value: -0.5, material: "metal", blocks: true },
    { value: 1, material: "metal", blocks: false },
  ];
  const panel = preparePanel(model);
  const before = structuredClone(model);
  const presentations = [matte, luminous].flatMap(profile =>
    [front, side].map(view => presentPanel(panel, profile, view, points)));

  for (const presentation of presentations) {
    assert.deepEqual(presentation.samples, expected);
  }
  assert.notDeepEqual(presentations[0].style, presentations[2].style);
  assert.notDeepEqual(presentations[0].view, presentations[1].view);
  assert.deepEqual(model, before);
});

test("повторная загрузка профиля воспроизводит его параметры и результат", () => {
  const panel = preparePanel(model);
  const points = [[1, 0, 0]];
  const first = presentPanel(panel, luminous, front, points);
  const loaded = JSON.parse(JSON.stringify(luminous));
  assert.deepEqual(presentPanel(panel, loaded, front, points), first);

  const changedSeed = presentPanel(panel, { ...loaded, seed: 24 }, front, points);
  assert.notEqual(changedSeed.style.grain, first.style.grain);
  assert.deepEqual(changedSeed.samples, first.samples);
});

test("семантические входы меняют проём и игровое ограничение независимо от профиля", () => {
  const original = preparePanel(model);
  const modifiedModel = structuredClone(model);
  modifiedModel.bindings.parameters.hole_size[0] = 1.25;
  const widened = preparePanel(modifiedModel);
  const passable = preparePanel({ ...model, rules: { interiorBlocks: false } });
  const point = [1, 0, 0];
  assert.deepEqual(original(point), { value: -0.5, material: "metal", blocks: true });
  assert.deepEqual(widened(point), { value: 0.25, material: "metal", blocks: false });
  assert.deepEqual(passable(point), { value: -0.5, material: "metal", blocks: false });
});

test("визуальные входы отвергаются на границе семантической модели", () => {
  assert.throws(() => preparePanel({ ...model, profile: matte }), { message: "E_MODEL" });
  assert.throws(() => preparePanel({ ...model, camera: front.camera }), { message: "E_MODEL" });
  assert.throws(() => preparePanel({ ...model, bindings: { ...model.bindings, lod: 1 } }),
    { message: "E_BINDINGS" });
  assert.throws(() => preparePanel({ ...model, rules: { ...model.rules, profile: matte } }),
    { message: "E_RULES" });
});
